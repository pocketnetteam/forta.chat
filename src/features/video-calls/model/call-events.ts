/**
 * MatrixCall event wiring of the call service: SDK state, feeds, hangup and error handlers, and the
 * diagnostics warning listener. Split out of call-service.ts without behaviour change.
 */
import { CallErrorCode, CallEvent, CallState as SDKCallState, type CallEventHandlerMap, type MatrixCall } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import { CallStatus, type CallHistoryEntry, useCallStore } from "@/entities/call";
import { playDialtone, playEndTone, stopAllSounds } from "./call-sounds";
import { type DiagnosticsWarningDetail, webrtcDiagnostics } from "./webrtc-diagnostics";
import { attachIceCandidateBuffer } from "./ice-candidate-buffer";
import { installVoipSendRetry } from "./voip-send-retry";
import { isNative } from "@/shared/lib/platform";
import { tRaw } from "@/shared/lib/i18n";
import { NativeWebRTC } from "@/shared/lib/native-webrtc";
import { useToast } from "@/shared/lib/use-toast";
import { nativeCallBridge } from "@/shared/lib/native-calls";
import { finalizeCall } from "./finalize-call";
import { clearIncomingCallSeen } from "./incoming-call-dedup";
import { cleanupRemoteFeedListener, mapSDKState, updateFeeds } from "./call-feeds";
import { DIAGNOSTICS_WARNING_KEYS } from "./call-tor-facts";
import { applySavedDevicesExact, getClient } from "./call-media";
import { clearConnectingWatchdog, clearIncomingTimeout } from "./call-timers";

/** Stored handler refs so we can remove them with call.off() */
let boundHandlers: {
  /** Call these handlers belong to, so teardown releases the right dedup slot. */
  callId: string;
  /**
   * The very object the handlers were attached to. Listener state on
   * MatrixCall is per instance, so detaching has to target this and not
   * whatever call the teardown happens to be called with.
   */
  call: MatrixCall;
  onState: CallEventHandlerMap[CallEvent.State];
  onReplaced: CallEventHandlerMap[CallEvent.Replaced];
  onFeeds: CallEventHandlerMap[CallEvent.FeedsChanged];
  onHangup: CallEventHandlerMap[CallEvent.Hangup];
  onError: CallEventHandlerMap[CallEvent.Error];
} | null = null;

// Listener bound on the diagnostics singleton when a PC is wrapped — kept
// at module scope so unwireCallEvents can detach it without holding a
// reference inside boundHandlers (we only get a PC from the SDK).
let diagnosticsWarningListener: EventListener | null = null;

/**
 * Detach the handlers wired by {@link wireCallEvents}.
 *
 * Takes no call on purpose: the handlers are always removed from the call they
 * were attached to, which `boundHandlers` remembers. Passing one in used to
 * imply a choice, and taking that choice detached from the wrong object.
 */
export function unwireCallEvents() {
  webrtcDiagnostics.detach();
  if (diagnosticsWarningListener) {
    webrtcDiagnostics.removeEventListener(
      "warning",
      diagnosticsWarningListener,
    );
    diagnosticsWarningListener = null;
  }
  cleanupRemoteFeedListener();
  if (!boundHandlers) return;
  // Session 31: release the dedup slot so a future invite with the same
  // callId (e.g. caller re-invited after the original was rejected) is
  // routed normally instead of being silently dropped.
  //
  // Keyed on the call whose handlers are actually being removed, and placed
  // after the guard above. Both matter: wireCallEvents opens by calling this
  // function on the call it is about to wire, so clearing `call.callId`
  // unconditionally wiped the mark handleIncomingCall had set moments before —
  // the 60 s dedup window never survived past the same tick, and a second
  // delivery of the same invite rang again.
  if (boundHandlers.callId) clearIncomingCallSeen(boundHandlers.callId);
  // Detach from the call the handlers were attached to, not from whichever
  // call was passed in. MatrixCall extends TypedEventEmitter, so listener
  // state is per instance: calling `off` on a different object is a silent
  // no-op that leaves the original call's handlers alive. Those handlers
  // then act on the store and on native teardown — which is not callId
  // scoped — so an old call reaching its timeout would tear down the live
  // one's audio and UI.
  const wired = boundHandlers.call;
  try {
    wired.off(CallEvent.State, boundHandlers.onState);
    wired.off(CallEvent.FeedsChanged, boundHandlers.onFeeds);
    wired.off(CallEvent.Hangup, boundHandlers.onHangup);
    wired.off(CallEvent.Error, boundHandlers.onError);
    wired.off(CallEvent.Replaced, boundHandlers.onReplaced);
  } catch { /* ignore */ }
  boundHandlers = null;
}

/**
 * Stop every local camera/mic (and screenshare) track held by a call.
 *
 * WEE-89 (regression of WEE-47): matrix-js-sdk does not reliably stop the
 * local getUserMedia tracks when a call ends on web, so the browser keeps
 * the camera/microphone captured and the tab's recording indicator (🔴)
 * stays lit after the call is over — a privacy problem. On mobile the held
 * mic also blocks the next call / the system from re-acquiring it. Stop the
 * tracks explicitly on every platform.
 *
 * Native audio-routing teardown stays in finalizeCall(); this only releases
 * the getUserMedia tracks the SDK leaves behind. MediaStreamTrack.stop() is
 * idempotent (a no-op on an already-ended track), so calling this from the
 * overlapping teardown paths (onState→ended, onHangup, onError, rejectCall,
 * hangup) is safe.
 */
export function releaseLocalMedia(call: MatrixCall): void {
  for (const stream of [call.localUsermediaStream, call.localScreensharingStream]) {
    try {
      stream?.getTracks().forEach((track) => track.stop());
    } catch (e) {
      console.warn("[call-service] releaseLocalMedia: track.stop failed:", e);
    }
  }
}

/**
 * C03 (calls review 2026-10-04): a call that ends while the SDK waits for
 * getUserMedia never adopts the stream — answer() and placeCall() return
 * before the feed is pushed, so releaseLocalMedia(call) finds nothing while
 * MediaHandler keeps the mic/camera open (and reuses that stream for the next
 * call). Stop every user media stream the handler holds, unless another call
 * is live and may own one of them.
 */
export function releaseUnadoptedMedia(call: MatrixCall): void {
  const live = useCallStore().matrixCall as MatrixCall | null;
  if (live && live !== call && live.callHasEnded?.() !== true) return;
  try {
    const handler = getClient()?.getMediaHandler?.();
    const streams: MediaStream[] = [...(handler?.userMediaStreams ?? [])];
    for (const stream of streams) handler.stopUserMediaStream(stream);
  } catch (e) {
    console.warn("[call-service] releaseUnadoptedMedia failed:", e);
  }
}

export function wireCallEvents(call: MatrixCall, direction: "outgoing" | "incoming") {
  // Defensive: remove any prior handlers first
  unwireCallEvents();

  // An answer, a restart offer or candidates that fail to send for lack of a
  // connection are retried instead of ending the call (voip-send-retry.ts).
  installVoipSendRetry(call as unknown as Parameters<typeof installVoipSendRetry>[0]);

  const callStore = useCallStore();

  // WEE-54 / forta-bugs#866 — phantom ringback guard.
  //
  // Closure-local (reset per call because wireCallEvents runs once per
  // MatrixCall) one-shot flag so the local ringback tone ("гудки") starts
  // exactly once, and only after the SDK has actually emitted the invite
  // to the homeserver (CallState.InviteSent). See the InviteSent branch
  // below for the full rationale.
  let ringbackStarted = false;
  // The SDK sets Connected again after an ICE restart (Wi-Fi to mobile
  // handover): the timer, startedAt and the native "connected" report belong
  // to the first time only, or the call's duration restarts from 0.
  let connectedOnce = false;
  // Set by onError when the SDK is about to end the call for that error:
  // the ended state then closes it as failed, not as an ordinary hangup.
  let errorEnding = false;

  const onState = ((newState: SDKCallState, _oldState: SDKCallState) => {
    const status = mapSDKState(newState, direction);
    callStore.updateStatus(status);
    // The SDK mutates `state` on the call object in place, which no ref sees.
    // `hasLiveCall` reads that field, so without this nudge it would answer
    // from cache and keep reporting a live call after this one ended.
    callStore.touchMatrixCall();

    // WEE-54 / forta-bugs#866: start the outgoing ringback only once the
    // invite has actually been sent to the homeserver (InviteSent), not
    // the instant the user taps dial. Previously playDialtone() ran
    // synchronously in startCallInner *before* placeVoiceCall(), so the
    // ringback played during local getUserMedia + offer creation + the
    // DTLS handshake — and even when the invite never left the device
    // (e.g. a failed placeCall), which users perceived as "гудки when the
    // peer was offline" (#866). Matrix 1:1 call signaling has no peer-ack
    // receipt, so InviteSent (invite delivered to the server) is the
    // earliest honest "we are now dialing the peer" signal we can gate on.
    // stopAllSounds() in the connected/ended/error/hangup paths stops it.
    if (
      direction === "outgoing" &&
      newState === SDKCallState.InviteSent &&
      !ringbackStarted
    ) {
      ringbackStarted = true;
      playDialtone();
    }

    // Any transition out of "connecting" cancels the watchdog — either
    // we connected successfully or the SDK itself decided to end/fail.
    if (status !== CallStatus.connecting) {
      clearConnectingWatchdog();
    }

    if (status === CallStatus.connected && connectedOnce) {
      stopAllSounds();
      updateFeeds(call);
    } else if (status === CallStatus.connected) {
      connectedOnce = true;
      stopAllSounds();
      clearIncomingTimeout();
      callStore.startTimer();
      if (callStore.activeCall) {
        callStore.setActiveCall({
          ...callStore.activeCall,
          startedAt: Date.now(),
        });
      }
      updateFeeds(call);
      // Apply saved device preferences with {exact} constraint
      applySavedDevicesExact(call);
      // Notify native ConnectionService that call is now active
      if (isNative) {
        import('@/shared/lib/native-calls').then(({ nativeCallBridge }) => {
          nativeCallBridge.reportCallConnected(call.callId);
        }).catch(() => {});
        NativeWebRTC.updateCallStatus({ status: "Connected", duration: "" }).catch(() => {});
      }
    }

    if (status === CallStatus.ended && errorEnding) {
      errorEnding = false;
      failCall();
      return;
    }

    if (status === CallStatus.ended) {
      stopAllSounds();
      clearIncomingTimeout();
      playEndTone();
      callStore.stopTimer();
      unwireCallEvents();
      // WEE-89: stop local camera/mic tracks on every platform. The SDK
      // doesn't reliably release getUserMedia on web, leaving the tab's
      // recording indicator lit after the call. Native finalizeCall below
      // still handles audio routing.
      releaseLocalMedia(call);
      // Single point of native cleanup. Idempotent per callId — if
      // hangup() / rejectCall() already finalized this call, this is a
      // no-op. Steps (stopAudioRouting → reportCallEnded → dismissCallUI
      // → closeAllPeerConnections) run in order with isolated error
      // handling so a leaked AudioRecord is always disposed.
      if (isNative) {
        void finalizeCall("sdk-ended", call.callId, call.roomId);
      }
      const activeCall = callStore.activeCall;
      if (activeCall) {
        const entry: CallHistoryEntry = {
          id: activeCall.callId,
          roomId: activeCall.roomId,
          peerId: activeCall.peerId,
          peerName: activeCall.peerName,
          type: activeCall.type,
          direction: activeCall.direction,
          status: activeCall.startedAt ? "answered" : "missed",
          startedAt: activeCall.startedAt ?? Date.now(),
          duration: callStore.callTimer,
        };
        callStore.addHistoryEntry(entry);
      }
      callStore.scheduleClearCall(1500);
    }
  }) as CallEventHandlerMap[CallEvent.State];

  const onFeeds = (() => {
    updateFeeds(call);
  }) as CallEventHandlerMap[CallEvent.FeedsChanged];

  const onHangup = (() => {
    stopAllSounds();
    clearIncomingTimeout();
    clearConnectingWatchdog();
    // WEE-89: release local media here too — the SDK sometimes fires Hangup
    // before State transitions to Ended (rejected-while-ringing), so don't
    // wait for onState→ended to stop the camera/mic tracks.
    releaseLocalMedia(call);
    // Also tear down the native surface. Without this, when the remote
    // cancels a call we never answered, or when another of our devices
    // picks up (m.call.select_answer), the SDK fires Hangup but the
    // native IncomingCallActivity + shade notification stay up forever.
    // onState → ended eventually does the same cleanup, but we can't
    // rely on it: the SDK sometimes fires Hangup before State transitions
    // for rejected-while-ringing cases. finalizeCall is idempotent per
    // callId so a follow-up onState→ended will be a no-op.
    if (isNative) {
      void finalizeCall("sdk-ended", call.callId, call.roomId);
    }
  }) as CallEventHandlerMap[CallEvent.Hangup];

  /** The end of a call the SDK ended with an error: status failed, a failed history entry. */
  const failCall = () => {
    stopAllSounds();
    clearIncomingTimeout();
    clearConnectingWatchdog();
    unwireCallEvents();
    // WEE-89: a failed call may have already acquired local media; release
    // it so the camera/mic don't stay captured after the error.
    releaseLocalMedia(call);
    if (isNative) {
      void finalizeCall("error", call.callId, call.roomId);
    }
    callStore.updateStatus(CallStatus.failed);
    const activeCall = callStore.activeCall;
    if (activeCall) {
      callStore.addHistoryEntry({
        id: activeCall.callId,
        roomId: activeCall.roomId,
        peerId: activeCall.peerId,
        peerName: activeCall.peerName,
        type: activeCall.type,
        direction: activeCall.direction,
        status: "failed",
        startedAt: activeCall.startedAt ?? Date.now(),
        duration: callStore.callTimer,
      });
    }
    callStore.scheduleClearCall(2000);
  };

  const onError = ((error: unknown) => {
    // Detailed log for debugging (e.g. ICE failure when WiFi ↔ 4G)
    const err = error as { code?: string; message?: string } | undefined;
    const code = err?.code ?? (error as Error)?.name;
    const msg = err?.message ?? (error as Error)?.message ?? String(error);
    console.error("[call-service] call error:", code ?? "unknown", msg, error);
    if (err && typeof err === "object" && !err.message && Object.keys(err).length > 0) {
      console.error("[call-service] error object:", JSON.stringify(err, null, 2));
    }
    // Not every SDK error ends the call. Most are followed at once by
    // terminate(), and onState(ended) then closes it as failed. A camera
    // that cannot be turned on mid-call (upgradeCall) leaves a working voice
    // call, and a failed answer send leaves the call ringing: tearing those
    // down here ended the call on this side only — the peer stayed in it.
    errorEnding = true;
    queueMicrotask(() => {
      if (!errorEnding || call.callHasEnded?.() === true) return;
      errorEnding = false;
      if (code === CallErrorCode.NoUserMedia && call.state === SDKCallState.Connected) {
        useToast().toast(tRaw("call.error.cameraUnavailable"), "error", 4000);
        return;
      }
      // Still alive after an error it cannot recover from: hang up properly
      // so the peer stops too; onState(ended) closes it as failed.
      errorEnding = true;
      try {
        call.hangup((code as CallErrorCode) ?? CallErrorCode.UserHangup, false);
      } catch (e) {
        console.warn("[call-service] hangup after error failed:", e);
        errorEnding = false;
        failCall();
      }
    });
  }) as CallEventHandlerMap[CallEvent.Error];

  // Glare: both sides dialled at once and the SDK resolved it by ending this
  // call and answering the other side's invite itself (replacedBy). That call
  // never reaches Call.incoming — no store entry, no screen, no hangup button,
  // yet live with the mic open. Hand-over to it is not supported (the native
  // call is keyed by this call's id), so it is hung up and both sides can
  // dial again; this call ends normally through onState.
  const onReplaced = ((newCall: MatrixCall) => {
    console.warn("[call-service] call", call.callId, "replaced by", newCall.callId, "after glare — hanging the successor up");
    try {
      newCall.hangup(CallErrorCode.UserHangup, false);
    } catch (e) {
      console.warn("[call-service] could not hang up the glare successor:", e);
    }
  }) as CallEventHandlerMap[CallEvent.Replaced];

  boundHandlers = { callId: call.callId, call, onState, onReplaced, onFeeds, onHangup, onError };
  call.on(CallEvent.Replaced, onReplaced);
  call.on(CallEvent.State, onState);
  call.on(CallEvent.FeedsChanged, onFeeds);
  call.on(CallEvent.Hangup, onHangup);
  call.on(CallEvent.Error, onError);

  // Attach WebRTC diagnostics (getStats polling, ICE/audio monitoring).
  // We may be invoked from BOTH the SDK's PeerConnectionCreated event
  // AND the polling fallback below — on Bastyon's matrix-js-sdk fork the
  // event often fires but the polling fires too for the same pc within
  // ~300ms. Mark the pc on first attach so path 2 is skipped. The
  // webrtcDiagnostics module itself also guards against double-wrap.
  const onPeerConnectionCreated = (pc: RTCPeerConnection) => {
    if ((pc as unknown as Record<string, unknown>).__callServiceDiagAttached) return;
    (pc as unknown as Record<string, unknown>).__callServiceDiagAttached = true;
    // Before the diagnostics wrapper: the SDK adds the candidates it buffered
    // during ringing *before* it sets the answer, and both engines reject
    // them without a remote description (see ice-candidate-buffer.ts).
    attachIceCandidateBuffer(pc);
    webrtcDiagnostics.attach(pc);

    // Session 03: the proxy fires "connectiondead" when ICE has been
    // failed for 20s after a restart attempt. At that point the call is
    // unrecoverable, so hang up cleanly with a user-visible toast
    // instead of leaving the user staring at a frozen UI.
    pc.addEventListener("connectiondead", () => {
      console.error("[call-service] PC connectiondead → hangup");
      try {
        useToast().toast(tRaw("call.error.connectionLost"), "error", 4000);
      } catch (e) {
        console.warn("[call-service] toast failed:", e);
      }
      try {
        call.hangup(CallErrorCode.IceFailed, false);
      } catch (e) {
        console.error(
          "[call-service] hangup after connectiondead failed:",
          e,
        );
      }
    });

    // Session 03: surface diagnostics warnings (no inbound/outbound
    // audio) as toasts. The diagnostics singleton emits each warning
    // type at most once per attach so the user sees one toast, not a
    // flood. Stored on a module ref so unwireCallEvents removes it.
    diagnosticsWarningListener = ((ev: Event) => {
      const detail = (ev as CustomEvent<DiagnosticsWarningDetail>).detail;
      if (!detail) return;
      const key = DIAGNOSTICS_WARNING_KEYS[detail.type];
      try {
        useToast().toast(tRaw(key), "info", 5000);
      } catch (e) {
        console.warn(
          "[call-service] toast failed for",
          detail.type,
          e,
        );
      }
    }) as EventListener;
    webrtcDiagnostics.addEventListener("warning", diagnosticsWarningListener);
  };
  if (typeof (call as any).on === "function" && (CallEvent as any).PeerConnectionCreated) {
    call.on((CallEvent as any).PeerConnectionCreated, onPeerConnectionCreated);
  }
  // Fallback: if SDK doesn't emit PeerConnectionCreated, attach once peerConn is set
  const pcCheck = setInterval(() => {
    const pc: RTCPeerConnection | undefined = (call as any).peerConn;
    if (pc && !(pc as any).__callServiceDiagAttached) {
      clearInterval(pcCheck);
      onPeerConnectionCreated(pc);
    }
  }, 300);
  setTimeout(() => clearInterval(pcCheck), 15000);
}
