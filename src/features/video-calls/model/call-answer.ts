/**
 * Answer, reject and hang up the active call, plus the native-answer helpers. Split out of
 * call-service.ts; each function reads the call store itself.
 */
import { CallErrorCode, type MatrixCall } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import { CallStatus, type CallInfo, useCallStore } from "@/entities/call";
import { matrixIdToAddress } from "@/entities/chat/lib/chat-helpers";
import { useUserStore } from "@/entities/user";
import { stopAllSounds } from "./call-sounds";
import { isNative } from "@/shared/lib/platform";
import { useBugReport } from "@/features/bug-report";
import { tRaw } from "@/shared/lib/i18n";
import { nativeCallBridge } from "@/shared/lib/native-calls";
import { PermissionDeniedError, callPermissionError, ensureCallPermissions } from "./permissions";
import { finalizeCall } from "./finalize-call";
import { maybeWarnLegacyWebView } from "./call-engine-setup";
import { syncRemoteVideoMuted } from "./call-feeds";
import { refreshPeerNameAsync } from "./call-peer-info";
import { warnIfCallBypassesTor } from "./call-tor-facts";
import { getClient, hintStoredDevices } from "./call-media";
import { CONNECTING_WATCHDOG_MS, armConnectingWatchdog, clearConnectingWatchdog, clearIncomingTimeout } from "./call-timers";
import { releaseLocalMedia, unwireCallEvents } from "./call-events";
import { launchNativeCallScreen } from "./call-native-screen";

// ---------------------------------------------------------------------------
// Answer-call re-entry lock (WEE-45 / forta-bugs#724)
// ---------------------------------------------------------------------------
// Synchronous re-entry guard for answerCall. The status-based guard inside
// answerCall reads `activeCall.status` and bails if it's already
// connecting/connected, but the first await (`ensureCallPermissions`) opens
// a ~100-400ms window during which the status is still 'incoming' even
// though answer is in flight. Without this sync flag, a double-tap on the
// accept button (forta-bugs#724) passes the guard twice and invokes
// `call.answer()` twice — the SDK then throws on the second invocation
// (state machine wedge) or doubles the SDP exchange, leaving the caller
// stuck on "connecting" forever.
//
// Module-scope is fine because there's at most one active answer attempt
// per process (call store enforces single-call), and resetting it in
// `finally` guarantees we never leak the lock across calls.
let answerInProgress = false;

export async function answerCall() {
  const callStore = useCallStore();
  const call = callStore.matrixCall as MatrixCall | null;
  if (!call) {
    console.warn("[call-service] answerCall: no matrixCall, bailing");
    return;
  }
  console.log("[call-service] answerCall: begin, callId=" + call.callId);

  // Sync re-entry guard (WEE-45 / forta-bugs#724) — catches double-taps
  // on the accept button before `await ensureCallPermissions` opens the
  // status-based guard's race window. The status guard below still
  // matters for cross-codepath races (e.g. native accept event vs Vue
  // tap), but only this flag is observable BEFORE the first await.
  if (answerInProgress) {
    console.warn("[call-service] answerCall: already in progress (sync guard), bailing");
    return;
  }

  // Guard against duplicate invocations. We intentionally allow
  // multiple answerCall() call sites (user tap in UI, native accept
  // event, pre-accepted push path, wait-for-matrix poll) because any
  // of them can realistically fire first, but all of them pass
  // through this check so only the first one actually answers.
  const currentStatus = callStore.activeCall?.status;
  if (currentStatus === CallStatus.connecting || currentStatus === CallStatus.connected) {
    console.warn("[call-service] answerCall: already " + currentStatus + ", guard bails");
    return;
  }

  answerInProgress = true;
  void warnIfCallBypassesTor();

  // forta-bugs#497 / WEE-53: same proactive legacy-WebView hint on the
  // answer path — an outdated callee should be told why the call may drop
  // before it connects, not only if a later network change skips restartIce.
  maybeWarnLegacyWebView();

  // Safety net per code-review: if any future edit inserts a throwing
  // synchronous call between here and the manual releases below, the
  // outer try/finally guarantees the lock is cleared on the way out so
  // a single bad edit can't permanently jam future incoming calls.
  try {

  // WEE-47 (#836): on the native non-pre-accepted incoming flow,
  // handleIncomingCall intentionally leaves callStore.activeCall null
  // so the Vue ringer (IncomingCallModal) does not double up over the
  // native IncomingCallActivity. When the user finally accepts from
  // the native ringer, NativeCallBridge fires callAnswered → answerCall
  // runs here with matrixCall set but activeCall still null. Every
  // store mutation below (`updateStatus(connecting)`, `setActiveCall`
  // in onState→connected, type upgrade in syncRemoteVideoMuted) is a
  // no-op when activeCall is null, so:
  //   - CallWindow.show stays false (callStore.activeCall?.status is
  //     never in ringing/connecting/connected),
  //   - the callee hears audio (native WebRTC pipeline) but sees a
  //     bare chat without mute/speaker/hangup controls.
  // Populate activeCall synchronously from matrixCall here — cached
  // profile if available, raw address otherwise — and schedule the
  // async profile refresh exactly like handleIncomingCall would have.
  if (!callStore.activeCall) {
    const opponentId =
      (call.getOpponentMember?.() as { userId?: string } | undefined)?.userId ?? "";
    const peerAddress = opponentId ? matrixIdToAddress(opponentId) : "";
    const cached = peerAddress ? useUserStore().getUser(peerAddress) : null;
    const peerName = cached?.name || peerAddress;
    const seedInfo: CallInfo = {
      callId: call.callId,
      roomId: call.roomId ?? "",
      peerId: opponentId,
      peerAddress,
      peerName,
      type: call.type === "video" ? "video" : "voice",
      direction: "incoming",
      status: CallStatus.incoming,
      startedAt: null,
      endedAt: null,
    };
    callStore.setActiveCall(seedInfo);
    callStore.videoMuted = seedInfo.type !== "video";
    if (peerAddress && peerName === peerAddress) {
      refreshPeerNameAsync(call.callId, peerAddress);
    }
  }

  clearIncomingTimeout();
  stopAllSounds();

  const isVideo = callStore.activeCall?.type === "video";

  // Preflight: mic (+ camera for video) BEFORE any SDK signaling. If
  // the OS denied permission we must NOT call `call.answer()` — doing
  // so would let Matrix SDK establish the peer connection with an empty
  // track and the caller would see "connected" with no audio. Instead
  // reject the call so the caller stops ringing and receives a clear
  // `m.call.reject`, then dismiss our own native UI.
  try {
    await ensureCallPermissions(isVideo);
  } catch (e) {
    if (e instanceof PermissionDeniedError) {
      console.warn(
        "[call-service] answerCall: permission denied for",
        e.device,
        "reason=" + e.reason,
      );
      callPermissionError.value = {
        device: e.device,
        reason: e.reason,
        conflicting: e.conflicting,
      };
    } else {
      console.error("[call-service] answerCall: ensureCallPermissions failed:", e);
    }
    // Detach SDK event listeners FIRST — if we call reject() below while
    // listeners are still bound, the SDK's State→Ended / Hangup events
    // would fire our onState/onHangup handlers, double-triggering
    // scheduleClearCall + duplicate history entry + redundant
    // dismissCallUI. Mirrors rejectCall()'s ordering.
    unwireCallEvents();
    try {
      call.reject();
    } catch (rejectErr) {
      console.warn("[call-service] answerCall: reject after permission failure errored:", rejectErr);
    }
    callStore.updateStatus(CallStatus.failed);
    callStore.scheduleClearCall(1500);
    // Idempotent teardown — permission check itself did not reach
    // startAudioRouting, but a previous accept attempt in this session
    // might have. finalizeCall is a no-op when nothing is set up yet.
    if (isNative) {
      void finalizeCall("permission-denied", call.callId, call.roomId);
    }
    // Release the re-entry lock — the user may legitimately retry the
    // same call after granting the previously-denied permission, and
    // a future incoming call must not be silently blocked.
    answerInProgress = false;
    return;
  }

  // The caller may have hung up while the permission prompt was open:
  // answer() on an ended call revives it (WaitLocalMedia), takes the mic and
  // can even send m.call.answer for a call that is over.
  if (call.callHasEnded?.() === true) {
    console.info("[call-service] answerCall: the call ended before it could be answered:", call.callId);
    answerInProgress = false;
    return;
  }

  callStore.updateStatus(CallStatus.connecting);

  // WEE-45: release the re-entry lock now that status === 'connecting'.
  // The pre-existing status-based guard at the top of answerCall covers
  // every subsequent re-entry path; holding the lock past this point
  // would permanently jam future answers if `await call.answer(...)`
  // below wedges (matches the watchdog test scenario for stuck SDKs).
  answerInProgress = false;

  // Hint stored device IDs (lightweight, sync) — real fix is post-connect
  const client = getClient();
  hintStoredDevices(client);

  // H3: watchdog — if we stay in "connecting" for 30s, tear the call
  // down. onState clears this watchdog whenever status transitions
  // away from connecting; hangup/reject clear it explicitly.
  clearConnectingWatchdog();
  armConnectingWatchdog(() => {
    if (callStore.activeCall?.status !== CallStatus.connecting) return;
    console.warn("[call-service] answerCall: stuck in connecting for 30s, forcing failed");
    unwireCallEvents();
    try {
      call.hangup(CallErrorCode.UserHangup, false);
    } catch { /* ignore */ }
    // WEE-89: listeners are unwired above, so onHangup/onState→ended won't
    // fire — release the media acquired in call.answer() ourselves so the
    // camera/mic don't stay captured after a watchdog timeout.
    releaseLocalMedia(call);
    callStore.updateStatus(CallStatus.failed);
    callStore.scheduleClearCall(2000);
    if (isNative) {
      void finalizeCall("watchdog-timeout", call.callId, call.roomId);
    }
  }, CONNECTING_WATCHDOG_MS);

  try {
    // H2: answer the SDK call FIRST so the peer sees m.call.answer
    // within ~200ms. launchCallUI on some OEMs takes 300-800ms to
    // bring the native Activity up — running it before call.answer()
    // meant the caller's timeout fired and they sent m.call.hangup,
    // which the user perceived as "他 dropped my call" (#310).
    console.log("[call-service] answerCall: calling SDK call.answer(true, " + isVideo + ")");
    await call.answer(true, isVideo);
    console.log("[call-service] answerCall: SDK call.answer resolved");

    // Hung up while answer() ran: teardown already happened (finalize is
    // once per call), so the call screen and audio routing must not come up
    // for a call that is over, and the stream answer() got is released here.
    if (call.callHasEnded?.() === true) {
      console.info("[call-service] answerCall: the call ended while answering:", call.callId);
      clearConnectingWatchdog();
      releaseLocalMedia(call);
      return;
    }

    // Non-blocking native UX transitions.
    if (isNative && callStore.activeCall) {
      launchNativeCallScreen({
        callerName: callStore.activeCall.peerName,
        callType: callStore.activeCall.type,
        callId: call.callId,
        direction: "incoming",
      }).catch((e) => console.warn("[call-service] launchCallUI failed:", e));
    }

    // Activate native VoIP audio routing after answering. Graceful
    // degradation on failure — never drop the call for a routing hiccup.
    // WEE-16: the bridge now retries with a backoff and never rejects;
    // failures are logged inside the bridge.
    if (isNative) {
      const callType = isVideo ? "video" : "voice";
      void nativeCallBridge.startAudioRouting({ callType });
    }
  } catch (e) {
    console.error("[call-service] Failed to answer call:", e);
    useBugReport().open({ context: tRaw("bugReport.ctx.answerCall"), error: e });
    clearConnectingWatchdog();
    unwireCallEvents();
    // WEE-89: call.answer may have run getUserMedia before throwing —
    // release any acquired camera/mic tracks so they aren't left captured.
    releaseLocalMedia(call);
    callStore.updateStatus(CallStatus.failed);
    callStore.scheduleClearCall(2000);
    // H1 + H7 + Session 23: always tear down audio routing on answer
    // failure. If call.answer threw *after* startAudioRouting queued
    // (it's fire-and-forget), MODE_IN_COMMUNICATION may already be
    // set. Prior to centralized finalize, the device could stay locked
    // in VoIP mode with BT SCO held open until reboot. finalizeCall
    // also dismisses the native UI and disposes peer-connection media
    // so a leaked AudioRecord cannot lock the mic device-wide.
    if (isNative) {
      void finalizeCall("error", call.callId, call.roomId);
    }
  }
  } finally {
    // Belt-and-suspenders: the manual releases above (permission-denied
    // and right after `updateStatus('connecting')`) already cleared the
    // flag for the common paths, but this guarantees no exit route can
    // leave the lock stuck — including any hypothetical sync throw
    // between `answerInProgress = true` and the try below.
    answerInProgress = false;
  }
}

export function rejectCall() {
  const callStore = useCallStore();
  const call = callStore.matrixCall as MatrixCall | null;
  console.log("[call-service] rejectCall: invoked, hasCall=" + Boolean(call));
  if (!call) {
    // No MatrixCall but the modal might still be up — make sure the
    // Vue ringer disappears anyway so the user isn't stuck on the
    // decline button. This guards the "ghost incoming" state where
    // activeCall got set without matrixCall (e.g. an SDK race).
    stopAllSounds();
    clearIncomingTimeout();
    callStore.clearCall();
    return;
  }

  clearIncomingTimeout();
  clearConnectingWatchdog();
  stopAllSounds();
  // Before reject(): the SDK ends the call synchronously inside it, and the
  // still-wired State handler then logged a "missed" entry and played the
  // end tone for a call the user just declined — two history entries.
  // Everything that handler would do runs here instead.
  unwireCallEvents();

  // WEE-31 follow-up: previously a throw inside call.reject() — most
  // commonly on web when the SDK call is in Fledgling state and rejects
  // a reject() — was only logged. The modal stayed mounted because
  // clearCall() was unreachable, leaving the user stuck on the decline
  // button with no visible effect. Wrap the SDK call so the local
  // teardown ALWAYS runs even when the protocol-level reject fails.
  try {
    call.reject();
    console.log("[call-service] rejectCall: SDK call.reject resolved");
  } catch (e) {
    console.warn("[call-service] rejectCall: SDK reject error (continuing teardown):", e);
    // Fallback: try hangup() — on some SDK paths reject() requires the
    // call to be in 'Ringing' state, but hangup() works from any state
    // and produces the same observable outcome for the caller (they
    // see m.call.hangup and stop ringing).
    try {
      call.hangup(CallErrorCode.UserHangup, false);
    } catch (e2) {
      console.warn("[call-service] rejectCall: fallback hangup also threw:", e2);
    }
  }

  // Centralized native cleanup — release audio routing, dismiss UI,
  // close any peer connections that were started during a prior answer
  // attempt. Idempotent on native side; safe even if the router never
  // started for an incoming call that began from ringing.
  if (isNative) {
    void finalizeCall("reject", call.callId, call.roomId);
  }

  // WEE-89: a call rejected after it acquired media (e.g. answered then
  // declined elsewhere) must release the camera/mic. No-op when rejected
  // while still ringing (no local stream acquired yet).
  releaseLocalMedia(call);

  if (callStore.activeCall) {
    callStore.addHistoryEntry({
      id: callStore.activeCall.callId,
      roomId: callStore.activeCall.roomId,
      peerId: callStore.activeCall.peerId,
      peerName: callStore.activeCall.peerName,
      type: callStore.activeCall.type,
      direction: callStore.activeCall.direction,
      status: "declined",
      startedAt: Date.now(),
      duration: 0,
    });
  }
  callStore.clearCall();
  console.log("[call-service] rejectCall: complete, callStore cleared");
}

export function hangup() {
  const callStore = useCallStore();
  const call = callStore.matrixCall as MatrixCall | null;
  if (!call) return;

  clearIncomingTimeout();
  clearConnectingWatchdog();
  stopAllSounds();

  try {
    call.hangup(CallErrorCode.UserHangup, false);
  } catch (e) {
    console.warn("[call-service] hangup error:", e);
  }

  // Tear down everything eagerly. The SDK's Ended state also calls
  // finalizeCall, but we run it here too so the user's earpiece /
  // speaker / mic / wake lock release immediately — even if Ended is
  // delayed by 200-500ms while the SDK negotiates. Idempotent per
  // callId, so the follow-up Ended is a no-op.
  if (isNative) {
    void finalizeCall("hangup", call.callId, call.roomId);
  }

  // WEE-89: stop local tracks immediately on user hangup so the browser's
  // recording indicator clears without waiting for the SDK's Ended
  // transition (which onState→ended also releases — idempotent).
  releaseLocalMedia(call);

  // Fallback cleanup if SDK doesn't fire Ended event (#11)
  callStore.scheduleClearCall(3000);
}

/**
 * The call `hangup`/`rejectCall` would act on right now.
 *
 * Read by the native bridge to scope `callEnded`/`callDeclined` to the call
 * they name: both commands below act on `callStore.matrixCall`, so the
 * bridge must be able to see the same value they will. The room travels with
 * the id because a push-created connection's id can never be compared with a
 * Matrix one.
 */
export function currentCall(): { callId: string | undefined; roomId?: string } {
  const callStore = useCallStore();
  const call = callStore.matrixCall as MatrixCall | null;
  return { callId: call?.callId, roomId: call?.roomId };
}

/**
 * Native answered a call that never reached JS — accepted on the ringer just
 * as the caller hung up, so /sync brought the invite and its hangup together
 * and the SDK made no call. The Telecom connection stayed ACTIVE until a
 * backstop ended it, and every call meanwhile was refused as busy. Left
 * alone when a call is live here: that call owns the native side.
 */
export function releaseOrphanedNativeAnswer(callId: string, roomId?: string) {
  const callStore = useCallStore();
  if (callStore.hasLiveCall) return;
  console.warn("[call-service] releasing a native answer no call arrived for:", callId);
  void finalizeCall("answer-orphaned", callId, roomId);
}
