import { createNewMatrixCall, CallEvent, CallState as SDKCallState, CallErrorCode } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import type { MatrixCall, CallEventHandlerMap } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import { getMatrixClientService } from "@/entities/matrix";
import { useCallStore, CallStatus } from "@/entities/call";
import type { CallType, CallInfo, CallHistoryEntry } from "@/entities/call";
import { matrixIdToAddress } from "@/entities/chat/lib/chat-helpers";
import { useUserStore } from "@/entities/user";
import type { CallFeed } from "matrix-js-sdk-bastyon/lib/webrtc/callFeed";
import { playRingtone, playDialtone, playEndTone, stopAllSounds } from "./call-sounds";
import { checkOtherTabHasCall } from "./call-tab-lock";
import { webrtcDiagnostics } from "./webrtc-diagnostics";
import type { DiagnosticsWarningDetail } from "./webrtc-diagnostics";
import { isNative } from "@/shared/lib/platform";
import { useBugReport } from "@/features/bug-report";
import { tRaw } from "@/shared/lib/i18n";
import { installNativeWebRTCProxy, NativeWebRTC } from "@/shared/lib/native-webrtc";
import { onConnectivityChange } from "@/shared/lib/connectivity";
import { useToast } from "@/shared/lib/use-toast";
import {
  nativeCallBridge,
  consumePendingAnswerCallId,
  consumePendingRejectCallId,
} from "@/shared/lib/native-calls";
import { ensureCallPermissions, PermissionDeniedError, callPermissionError } from "./permissions";
import { finalizeCall } from "./finalize-call";
import { isLegacyWebView, MIN_CHROMIUM_MAJOR_FOR_MODERN_WEBRTC } from "./webview-compatibility";
import {
  isIncomingCallSeen,
  markIncomingCallSeen,
  clearIncomingCallSeen,
} from "./incoming-call-dedup";

/**
 * One-shot guard so the legacy-WebView toast fires only once per process,
 * not every time the user changes networks during a single call. Reset
 * implicitly by a full app restart, which is correct: the user may have
 * updated WebView in the meantime.
 */
let legacyWebViewToastShown = false;

function maybeWarnLegacyWebView(): void {
  if (legacyWebViewToastShown) return;
  legacyWebViewToastShown = true;
  try {
    // The shared toast surface only models info/success/error severities.
    // We use "info" with an extended duration (6s) so the user has time
    // to read the Play Store update hint without it feeling like a hard
    // error — the call may still complete on best-effort signaling.
    useToast().toast(tRaw("call.error.legacyWebView"), "info", 6000);
  } catch (e) {
    console.warn("[call-service] legacy WebView toast failed:", e);
  }
}

// Module-scope handle for the connectivity subscription so we don't stack
// listeners on HMR / repeated module evaluation. Declared above the
// `if (isNative)` block so the function can read it without hitting TDZ.
let _networkChangeUnsubscribe: (() => void) | null = null;

// Install native WebRTC proxy on mobile — must run before any call is placed.
// This replaces window.RTCPeerConnection so that the Matrix SDK transparently
// uses the native Android/iOS WebRTC engine instead of the browser's.
if (isNative) {
  installNativeWebRTCProxy();
  // D-11: Listen for native audio errors
  NativeWebRTC.addListener("onAudioError", (data) => {
    console.warn(`[call-service] Native audio error: ${data.type} — ${data.message}`);
    const callStore = useCallStore();
    if (data.type === "permission_denied") {
      callStore.updateStatus(CallStatus.failed);
      callStore.scheduleClearCall(1500);
    }
  });

  // Session 03: WiFi↔cellular handover does not reliably fire
  // window.online/offline on Android WebView. We subscribe to
  // @capacitor/network instead so transport flips during a live call
  // trigger an explicit ICE restart instead of waiting for the SDK's
  // sentinel timeout (by which time the call has already dropped).
  //
  // Idempotent registration: HMR / repeated module evaluation must not
  // stack listeners. We hold the unsubscribe handle so a future teardown
  // path (e.g. a hot reload helper) can call it; right now we only need
  // the once-per-process guarantee.
  registerNetworkChangeRestart();
}

function registerNetworkChangeRestart(): void {
  if (_networkChangeUnsubscribe) return;
  _networkChangeUnsubscribe = onConnectivityChange((change) => {
    if (!change.connected) return;
    if (change.previousType === change.type) return;

    const callStore = useCallStore();
    const matrixCall = callStore.matrixCall as MatrixCall | null;
    if (!matrixCall) return;
    const pc = (matrixCall as unknown as { peerConn?: RTCPeerConnection })
      .peerConn;
    if (!pc) return;

    // Don't restart while the SDK is mid-glare (have-local-offer /
    // have-remote-offer / have-local-pranswer / have-remote-pranswer):
    // a second restartIce in that window leaves libwebrtc with mismatched
    // SDP state and we end up wedged in "checking" forever — exactly the
    // failure mode this code is meant to prevent. The proxy's
    // restartIce() also debounces concurrent calls, but the cheaper
    // check here is to skip the call entirely if signaling is unstable.
    if (pc.signalingState !== "stable") {
      console.log(
        `[call-service] skip restartIce on network change (${change.previousType}→${change.type}); signalingState=${pc.signalingState}`,
      );
      return;
    }

    const state = pc.iceConnectionState;
    if (
      state === "connected" ||
      state === "completed" ||
      state === "disconnected" ||
      state === "checking"
    ) {
      // Session 30: Huawei Android 10 (HONOR 8X / STK-LX1) and similar
      // GMS-stripped devices ship Chromium ~83-96 in Android System WebView.
      // restartIce on those builds wedges signalingState in "have-local-offer"
      // because the rollback path for ICE renegotiation was buggy until
      // Chromium 100. Skip the recovery and let the SDK end the call
      // gracefully — far better UX than a frozen "connecting…" loop. We
      // surface a one-time toast so the user can update WebView from Play
      // Store; calling that out here (during a real network event) is
      // higher signal than at call start where most users dismiss it.
      // C1: WebView-engine guard only applies to web/Electron callers. On
      // native (Android/iOS), `installNativeWebRTCProxy` swaps the SDK's
      // RTCPeerConnection for a native bridge — `pc.restartIce()` here
      // forwards to the platform's bundled libwebrtc, not the WebView's.
      // `navigator.userAgent` reports the WebView Chrome version which has
      // no bearing on the actual ICE engine. Running the guard on native
      // would falsely block recovery on devices whose bundled libwebrtc
      // is fine, while doing nothing for the very devices the guard was
      // meant to help (since their Vue UI never drives this code path on
      // the bug-report flow). The native side has its own connectiondead
      // path (see [call-service.ts onPeerConnectionCreated]) which already
      // surfaces a typed error to the user.
      if (!isNative && isLegacyWebView()) {
        console.warn(
          `[call-service] skip restartIce on network change (${change.previousType}→${change.type}); legacy WebView (Chromium <${MIN_CHROMIUM_MAJOR_FOR_MODERN_WEBRTC})`,
        );
        maybeWarnLegacyWebView();
        return;
      }
      console.warn(
        `[call-service] network ${change.previousType}→${change.type}, restartIce`,
      );
      try {
        pc.restartIce();
      } catch (e) {
        console.error(
          "[call-service] restartIce on network change failed:",
          e,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// SDK state → store status mapping
// ---------------------------------------------------------------------------

function mapSDKState(state: SDKCallState, direction: "outgoing" | "incoming"): CallStatus {
  switch (state) {
    case SDKCallState.Ringing:
      return direction === "outgoing" ? CallStatus.ringing : CallStatus.incoming;
    case SDKCallState.Connecting:
    case SDKCallState.CreateOffer:
    case SDKCallState.CreateAnswer:
    case SDKCallState.InviteSent:
    case SDKCallState.WaitLocalMedia:
      return CallStatus.connecting;
    case SDKCallState.Connected:
      return CallStatus.connected;
    case SDKCallState.Ended:
      return CallStatus.ended;
    default:
      return CallStatus.connecting;
  }
}

// ---------------------------------------------------------------------------
// Feed helpers — use SDK typed getters (#7)
// ---------------------------------------------------------------------------

function updateFeeds(call: MatrixCall) {
  const callStore = useCallStore();
  try {
    // Local: always camera feed (for PiP), never screenshare
    callStore.setLocalStream(call.localUsermediaStream ?? null);
    // Local screen share stream (for self-preview when sharing)
    callStore.setLocalScreenStream(call.localScreensharingStream ?? null);
    // Remote camera (usermedia only — carries audio track too)
    callStore.setRemoteStream(call.remoteUsermediaStream ?? null);
    // Remote screen share as a separate stream
    callStore.setRemoteScreenStream(call.remoteScreensharingStream ?? null);
    callStore.remoteScreenSharing = !!call.remoteScreensharingStream;
    // Sync remote video mute state + wire listener
    syncRemoteVideoMuted(call);
  } catch (e) {
    console.warn("[call-service] updateFeeds error:", e);
  }
}

// ---------------------------------------------------------------------------
// Remote video mute detection
// ---------------------------------------------------------------------------

let trackedRemoteFeed: CallFeed | null = null;
let remoteFeedMuteHandler: ((audioMuted: boolean, videoMuted: boolean) => void) | null = null;

function cleanupRemoteFeedListener() {
  if (trackedRemoteFeed && remoteFeedMuteHandler) {
    try {
      trackedRemoteFeed.off("mute_state_changed" as any, remoteFeedMuteHandler);
    } catch { /* ignore */ }
  }
  trackedRemoteFeed = null;
  remoteFeedMuteHandler = null;
}

function syncRemoteVideoMuted(call: MatrixCall) {
  const callStore = useCallStore();
  const remoteFeed = call.remoteUsermediaFeed as CallFeed | undefined;

  /** Upgrade call type to "video" when remote peer enables camera */
  const maybeUpgradeToVideo = (videoMuted: boolean) => {
    if (!videoMuted && callStore.activeCall?.type === "voice") {
      callStore.setActiveCall({ ...callStore.activeCall, type: "video" });
    }
  };

  // If feed changed, re-wire listener
  if (remoteFeed !== trackedRemoteFeed) {
    cleanupRemoteFeedListener();

    if (remoteFeed) {
      const initialMuted = remoteFeed.isVideoMuted();
      callStore.remoteVideoMuted = initialMuted;
      maybeUpgradeToVideo(initialMuted);
      if (isNative) {
        NativeWebRTC.updateRemoteVideoState({ muted: initialMuted }).catch(() => {});
      }
      remoteFeedMuteHandler = (_audioMuted: boolean, videoMuted: boolean) => {
        callStore.remoteVideoMuted = videoMuted;
        maybeUpgradeToVideo(videoMuted);
        if (isNative) {
          NativeWebRTC.updateRemoteVideoState({ muted: videoMuted }).catch(() => {});
        }
      };
      trackedRemoteFeed = remoteFeed;
      remoteFeed.on("mute_state_changed" as any, remoteFeedMuteHandler);
    } else {
      // No remote feed yet → treat as muted
      callStore.remoteVideoMuted = true;
    }
  } else if (remoteFeed) {
    // Same feed, just re-check state
    callStore.remoteVideoMuted = remoteFeed.isVideoMuted();
    maybeUpgradeToVideo(remoteFeed.isVideoMuted());
  }
}

// ---------------------------------------------------------------------------
// Event listener lifecycle (#1)
// ---------------------------------------------------------------------------

/** Stored handler refs so we can remove them with call.off() */
let boundHandlers: {
  onState: CallEventHandlerMap[CallEvent.State];
  onFeeds: CallEventHandlerMap[CallEvent.FeedsChanged];
  onHangup: CallEventHandlerMap[CallEvent.Hangup];
  onError: CallEventHandlerMap[CallEvent.Error];
} | null = null;

// Listener bound on the diagnostics singleton when a PC is wrapped — kept
// at module scope so unwireCallEvents can detach it without holding a
// reference inside boundHandlers (we only get a PC from the SDK).
let diagnosticsWarningListener: EventListener | null = null;

function unwireCallEvents(call: MatrixCall) {
  webrtcDiagnostics.detach();
  if (diagnosticsWarningListener) {
    webrtcDiagnostics.removeEventListener(
      "warning",
      diagnosticsWarningListener,
    );
    diagnosticsWarningListener = null;
  }
  cleanupRemoteFeedListener();
  // Session 31: release the dedup slot so a future invite with the same
  // callId (e.g. caller re-invited after the original was rejected) is
  // routed normally instead of being silently dropped.
  if (call.callId) clearIncomingCallSeen(call.callId);
  if (!boundHandlers) return;
  try {
    call.off(CallEvent.State, boundHandlers.onState);
    call.off(CallEvent.FeedsChanged, boundHandlers.onFeeds);
    call.off(CallEvent.Hangup, boundHandlers.onHangup);
    call.off(CallEvent.Error, boundHandlers.onError);
  } catch { /* ignore */ }
  boundHandlers = null;
}

function wireCallEvents(call: MatrixCall, direction: "outgoing" | "incoming") {
  // Defensive: remove any prior handlers first
  unwireCallEvents(call);

  const callStore = useCallStore();

  const onState = ((newState: SDKCallState, _oldState: SDKCallState) => {
    const status = mapSDKState(newState, direction);
    callStore.updateStatus(status);

    // Any transition out of "connecting" cancels the watchdog — either
    // we connected successfully or the SDK itself decided to end/fail.
    if (status !== CallStatus.connecting) {
      clearConnectingWatchdog();
    }

    if (status === CallStatus.connected) {
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

    if (status === CallStatus.ended) {
      stopAllSounds();
      clearIncomingTimeout();
      playEndTone();
      callStore.stopTimer();
      unwireCallEvents(call);
      // Single point of native cleanup. Idempotent per callId — if
      // hangup() / rejectCall() already finalized this call, this is a
      // no-op. Steps (stopAudioRouting → reportCallEnded → dismissCallUI
      // → closeAllPeerConnections) run in order with isolated error
      // handling so a leaked AudioRecord is always disposed.
      if (isNative) {
        void finalizeCall("sdk-ended", call.callId);
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
    // Also tear down the native surface. Without this, when the remote
    // cancels a call we never answered, or when another of our devices
    // picks up (m.call.select_answer), the SDK fires Hangup but the
    // native IncomingCallActivity + shade notification stay up forever.
    // onState → ended eventually does the same cleanup, but we can't
    // rely on it: the SDK sometimes fires Hangup before State transitions
    // for rejected-while-ringing cases. finalizeCall is idempotent per
    // callId so a follow-up onState→ended will be a no-op.
    if (isNative) {
      void finalizeCall("sdk-ended", call.callId);
    }
  }) as CallEventHandlerMap[CallEvent.Hangup];

  const onError = ((error: unknown) => {
    // Detailed log for debugging (e.g. ICE failure when WiFi ↔ 4G)
    const err = error as { code?: string; message?: string } | undefined;
    const code = err?.code ?? (error as Error)?.name;
    const msg = err?.message ?? (error as Error)?.message ?? String(error);
    console.error("[call-service] call error:", code ?? "unknown", msg, error);
    if (err && typeof err === "object" && !err.message && Object.keys(err).length > 0) {
      console.error("[call-service] error object:", JSON.stringify(err, null, 2));
    }
    stopAllSounds();
    clearIncomingTimeout();
    clearConnectingWatchdog();
    unwireCallEvents(call);
    if (isNative) {
      void finalizeCall("error", call.callId);
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
  }) as CallEventHandlerMap[CallEvent.Error];

  boundHandlers = { onState, onFeeds, onHangup, onError };
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
      const key =
        detail.type === "no_inbound_audio"
          ? "call.warning.noInboundAudio"
          : "call.warning.noOutboundAudio";
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

// ---------------------------------------------------------------------------
// Incoming call timeout (#10)
// ---------------------------------------------------------------------------

let incomingTimeoutId: ReturnType<typeof setTimeout> | null = null;

function clearIncomingTimeout() {
  if (incomingTimeoutId !== null) {
    clearTimeout(incomingTimeoutId);
    incomingTimeoutId = null;
  }
}

// ---------------------------------------------------------------------------
// Connecting watchdog (H3)
// ---------------------------------------------------------------------------

/**
 * If `call.answer()` resolves but `onState→Connected` never fires (SDK
 * wedged on peer-connection setup, OEM audio init deadlock, network
 * partition during ICE), the UI sits in "connecting..." forever. Users
 * perceive this as the call "crashing" (#268, #309). Force-fail after
 * 30s with full teardown so the store clears and the user can try again.
 */
const CONNECTING_WATCHDOG_MS = 30_000;
let connectingWatchdogId: ReturnType<typeof setTimeout> | null = null;

function clearConnectingWatchdog() {
  if (connectingWatchdogId !== null) {
    clearTimeout(connectingWatchdogId);
    connectingWatchdogId = null;
  }
}

// ---------------------------------------------------------------------------
// Device restore helper (#5)
// ---------------------------------------------------------------------------

/**
 * Lightweight: just store device IDs in mediaHandler so the SDK uses them
 * in its initial getUserMedia constraints. This is best-effort ({ideal}).
 * The real fix is applySavedDevicesExact() which runs after call connects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hintStoredDevices(client: any) {
  try {
    const mediaHandler = client?.getMediaHandler?.();
    if (!mediaHandler) return;
    const savedAudio = localStorage.getItem("bastyon_call_audio_device") ?? "";
    const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
    if (savedAudio || savedVideo) {
      mediaHandler.restoreMediaSettings(savedAudio, savedVideo);
    }
  } catch (e) {
    console.warn("[call-service] hintStoredDevices error:", e);
  }
}

/**
 * After call connects, check if current tracks match saved preferences.
 * If not, apply with {exact} constraint via sender.replaceTrack().
 */
async function applySavedDevicesExact(call: MatrixCall) {
  try {
    const savedAudio = localStorage.getItem("bastyon_call_audio_device") ?? "";
    const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
    if (!savedAudio && !savedVideo) return;

    const localStream = call.localUsermediaStream;
    if (!localStream) return;

    // Check audio
    if (savedAudio) {
      const currentAudioTrack = localStream.getAudioTracks()[0];
      const currentAudioId = currentAudioTrack?.getSettings()?.deviceId ?? "";
      if (currentAudioId !== savedAudio) {
        await useCallService().setAudioDevice(savedAudio);
      }
    }

    // Check video
    if (savedVideo) {
      const currentVideoTrack = localStream.getVideoTracks()[0];
      if (currentVideoTrack) {
        const currentVideoId = currentVideoTrack.getSettings()?.deviceId ?? "";
        if (currentVideoId !== savedVideo) {
          await useCallService().setVideoDevice(savedVideo);
        }
      }
    }
  } catch (e) {
    console.warn("[call-service] applySavedDevicesExact error:", e);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maximum wall-clock the call setup will wait for the peer's profile
 * before falling back to the blockchain address. Keeps the answer→media
 * negotiation inside the SDK's 1s window — exceeding that lets the caller's
 * timeout fire first and the user perceives the call as "dropped".
 */
const PEER_PROFILE_LOOKUP_TIMEOUT_MS = 500;

/**
 * Resolve the opponent's display name for the call surfaces.
 *
 * Pre-Session-30 this was synchronous: `loadUserIfMissing` was fired-and-
 * forgotten, then `getUser` was read on the next line — so profiles that
 * weren't already cached fell through to the raw blockchain address. The
 * native ringer rendered that address as "Unknown" and Vue surfaces showed
 * a long opaque string (#645).
 *
 * The fix is bounded: race a real `loadUsersBatch` against a 500ms timer.
 * Cached hits return instantly; cold lookups get a half-second window which
 * is enough on 4G to fetch a single profile via dedupe + the existing
 * profilePool. Even if we fall through, [refreshPeerNameAsync] below
 * subscribes for the late update so Vue UI eventually shows the right name.
 */
async function resolvePeerInfo(peerId: string): Promise<{ peerAddress: string; peerName: string }> {
  const peerAddress = matrixIdToAddress(peerId);
  const userStore = useUserStore();

  // Fast path: profile already cached with a name. Avoids the timer hop
  // for the common case where the caller has been seen recently.
  const cached = userStore.getUser(peerAddress);
  if (cached?.name) {
    return { peerAddress, peerName: cached.name };
  }

  // Bounded wait — `loadUsersBatch` is dedupe-aware so concurrent calls do
  // not multiply network requests. Suppress its rejection because a network
  // failure must not break call setup; we always have the address fallback.
  await Promise.race([
    userStore.loadUsersBatch([peerAddress]).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, PEER_PROFILE_LOOKUP_TIMEOUT_MS)),
  ]);

  const user = userStore.getUser(peerAddress);
  return {
    peerAddress,
    peerName: user?.name || peerAddress,
  };
}

/**
 * Late-arriving profile update for an already-active call.
 *
 * If [resolvePeerInfo]'s 500ms window expired without a profile, the call
 * surfaces show the blockchain address. This helper continues the load in
 * the background and patches `activeCall.peerName` once a real name lands,
 * but only if the same call is still active — guards against races where
 * the user hung up and started a new call before the profile arrived.
 *
 * Scope: Vue store only. The native CallActivity / IncomingCallActivity
 * read `callerName` from Intent extras at launch and there is no Kotlin
 * bridge to update them mid-call yet. So this helper fixes the JS-side
 * surfaces (CallStatusBar, CallWindow, IncomingCallModal) but the native
 * ringer / in-call screen will continue to show whatever name was passed
 * to `launchCallUI`. Adding a Kotlin updateCallerInfo bridge is tracked
 * separately — flagged in the call-service.ts handleIncomingCall branches.
 *
 * Pre-condition: the caller MUST have already invoked `setActiveCall`
 * with a matching callId before scheduling this. Branches that keep
 * activeCall null (the native non-fast-path) will never satisfy the
 * guard inside, so calling this from there is a no-op and a wasted
 * network round-trip.
 */
function refreshPeerNameAsync(callId: string, peerAddress: string): void {
  const userStore = useUserStore();
  const callStore = useCallStore();
  userStore
    .loadUsersBatch([peerAddress])
    .then(() => {
      const user = userStore.getUser(peerAddress);
      const name = user?.name;
      if (!name) return;
      const active = callStore.activeCall;
      if (!active || active.callId !== callId) return;
      if (active.peerName === name) return;
      callStore.setActiveCall({ ...active, peerName: name });
    })
    .catch(() => {
      // Network failure — call already shows the address fallback, no UX
      // regression. Logged at debug level only to avoid spamming Sentry.
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getClient(): any {
  return getMatrixClientService().client;
}

// ---------------------------------------------------------------------------
// Toggle camera lock (#2)
// ---------------------------------------------------------------------------

let toggleCameraLock = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function useCallService() {
  const callStore = useCallStore();

  async function startCall(roomId: string, type: CallType) {
    if (callStore.isInCall) {
      console.warn("[call-service] Already in a call");
      return;
    }

    const otherTabActive = await checkOtherTabHasCall();
    if (otherTabActive) {
      console.warn("[call-service] Another tab already has an active call");
      return;
    }

    callStore.cancelScheduledClear();

    // Preflight: mic (+ camera for video). Throws PermissionDeniedError
    // if the OS denied access, or if getUserMedia returns a stream with
    // empty tracks. If we skip this and let the SDK's getUserMedia fail
    // silently, the peer sees an invite, accepts, but there is no media
    // to exchange — that is the origin of the mass "no audio" reports.
    try {
      await ensureCallPermissions(type === "video");
    } catch (e) {
      if (e instanceof PermissionDeniedError) {
        console.warn(
          "[call-service] startCall: permission denied for",
          e.device,
          "reason=" + e.reason,
        );
        callPermissionError.value = {
          device: e.device,
          reason: e.reason,
          conflicting: e.conflicting,
        };
      } else {
        console.error("[call-service] startCall: ensureCallPermissions failed:", e);
      }
      callStore.updateStatus(CallStatus.failed);
      callStore.scheduleClearCall(1500);
      return;
    }

    const matrixService = getMatrixClientService();
    const client = matrixService.client;
    if (!client) {
      console.error("[call-service] No Matrix client");
      return;
    }

    // SDK may expose supportsVoip() or canSupportVoip; prefer method call
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supportsVoip = typeof (client as any).supportsVoip === "function"
      ? (client as any).supportsVoip()
      : (client as any).canSupportVoip === true;

    const call = createNewMatrixCall(client, roomId);
    if (!call) {
      console.error("[call-service] createNewMatrixCall returned null — WebRTC not available (secure context + RTCPeerConnection required)");
      return;
    }
    if (!supportsVoip) {
      console.warn("[call-service] VoIP not supported by client but call created — attempting anyway");
    }

    const room = client.getRoom(roomId);
    const myUserId = matrixService.getUserId();
    const members: Array<{ userId: string }> = room?.getJoinedMembers() ?? [];
    const peer = members.find((m) => m.userId !== myUserId);
    const peerId = peer?.userId ?? "";
    const { peerAddress, peerName } = await resolvePeerInfo(peerId);

    const callInfo: CallInfo = {
      callId: call.callId,
      roomId,
      peerId,
      peerAddress,
      peerName,
      type,
      direction: "outgoing",
      status: CallStatus.ringing,
      startedAt: null,
      endedAt: null,
    };

    callStore.setActiveCall(callInfo);
    callStore.setMatrixCall(call);
    callStore.videoMuted = type === "voice";
    wireCallEvents(call, "outgoing");

    // Late-arriving profile patch — only schedule when resolvePeerInfo's
    // 500ms timer fell through to the raw address (peerName === peerAddress
    // means no profile name was found). Skipping the no-op refresh in the
    // hot-cache path avoids a duplicate dedupe-pool round trip and a
    // redundant store write.
    if (peerAddress && peerName === peerAddress) {
      refreshPeerNameAsync(call.callId, peerAddress);
    }

    playDialtone();

    // Register outgoing call with Android ConnectionService + launch native UI
    if (isNative) {
      import('@/shared/lib/native-calls').then(({ nativeCallBridge }) => {
        nativeCallBridge.reportOutgoingCall({
          callId: call.callId,
          callerName: peerName,
          hasVideo: type === 'video',
        });
      }).catch(() => {});
      NativeWebRTC.launchCallUI({
        callerName: peerName,
        callType: type,
        callId: call.callId,
        direction: "outgoing",
      }).catch(() => {});
    }

    hintStoredDevices(client);

    try {
      if (type === "video") {
        await call.placeVideoCall();
      } else {
        await call.placeVoiceCall();
      }

      // Activate native VoIP audio routing — MODE_IN_COMMUNICATION,
      // setCommunicationDevice, BT hot-swap, OEM delayed re-apply.
      // Must come AFTER placeCall so the call exists; graceful degradation
      // on failure (no reason to drop the call if routing fails).
      if (isNative) {
        nativeCallBridge.startAudioRouting({ callType: type }).catch((e) => {
          console.warn("[call-service] startAudioRouting failed:", e);
        });
      }
    } catch (e) {
      console.error("[call-service] Failed to place call:", e);
      useBugReport().open({ context: tRaw("bugReport.ctx.placeCall"), error: e });
      stopAllSounds();
      unwireCallEvents(call);
      callStore.updateStatus(CallStatus.failed);
      callStore.scheduleClearCall(2000);
      // H1/H7 + Session 23: native side of startAudioRouting may have
      // already bumped the phone into MODE_IN_COMMUNICATION (it is queued
      // sync with placeCall). finalizeCall always runs the full teardown
      // chain (stop routing → report ended → dismiss UI → close PCs);
      // each step is idempotent on the native side, so calling it when
      // startAudioRouting never ran is just a no-op + one warn log.
      if (isNative) {
        void finalizeCall("error", call.callId);
      }
    }
  }

  async function handleIncomingCall(matrixCall: MatrixCall) {
    console.log(
      "[call-service] handleIncomingCall: callId=" + matrixCall.callId +
      ", roomId=" + matrixCall.roomId +
      ", type=" + matrixCall.type,
    );

    // Session 31 — Bastyon ↔ Forta interop dedup.
    //
    // Multi-client setups (Bastyon installed alongside Forta on the same
    // device, same Matrix user) and FCM-ringer-vs-sync races can cause the
    // SDK to emit Call.incoming twice for the same callId. Without this
    // guard the user sees a phantom second incoming-call UI on top of the
    // first — exactly what #644 reports on Xiaomi 12X / 14T.
    //
    // We silently skip duplicates instead of calling matrixCall.reject():
    // the original MatrixCall object (which the user can still answer via
    // the first ringer) handles the protocol-level lifecycle. Calling
    // reject() on the duplicate object would queue a redundant m.call.hangup
    // that the homeserver might fan out and confuse the caller's client.
    // The dedup window auto-clears after CALL_TIMEOUT_MS so a legitimate
    // re-invite minutes later still rings.
    if (matrixCall.callId && isIncomingCallSeen(matrixCall.callId)) {
      console.debug(
        "[call-service] duplicate Call.incoming ignored:",
        matrixCall.callId,
      );
      // Drop SDK-internal listeners on the orphan duplicate MatrixCall so
      // it can be GC'd promptly instead of waiting on the SDK's idle timer.
      try {
        (matrixCall as unknown as { removeAllListeners?: () => void })
          .removeAllListeners?.();
      } catch { /* ignore */ }
      return;
    }
    if (matrixCall.callId) markIncomingCallSeen(matrixCall.callId);

    // Check FIRST whether the user already declined this call in the
    // native ringer (before JS was running). If so, send the rejection
    // straight back to Matrix so the caller actually stops ringing.
    // Must come before the Pre-accepted check so an accidental double-
    // marker state can't accept a call the user rejected.
    if (isNative) {
      const alreadyRejected = await consumePendingRejectCallId(
        matrixCall.callId,
        matrixCall.roomId,
      );
      if (alreadyRejected) {
        console.log(
          "[call-service] Pre-rejected incoming call, calling reject():",
          matrixCall.callId,
        );
        try {
          matrixCall.reject();
        } catch (e) {
          console.error("[call-service] matrixCall.reject() failed:", e);
        }
        // Keep the dedup slot held: the user explicitly declined this
        // callId via the native ringer, so a stray SDK re-emit should
        // remain silent for the dedup window. The slot still auto-expires
        // after CALL_TIMEOUT_MS, which lets a determined caller redial.
        return;
      }
    }

    if (callStore.isInCall) {
      console.log("[call-service] handleIncomingCall: already in call, rejecting");
      matrixCall.reject();
      // Release the dedup slot: when the current call ends the user is
      // available again, and a legitimate re-invite from the same caller
      // (rare same-callId retry) should ring through instead of being
      // silently swallowed by the 60s window.
      if (matrixCall.callId) clearIncomingCallSeen(matrixCall.callId);
      return;
    }

    const otherTabActive = await checkOtherTabHasCall();
    if (otherTabActive) {
      console.warn("[call-service] Another tab already has an active call, rejecting incoming");
      matrixCall.reject();
      // Same rationale as the isInCall branch: ownership of the call is
      // delegated to the other tab — releasing our dedup slot lets a
      // future invite ring through normally if that tab closes.
      if (matrixCall.callId) clearIncomingCallSeen(matrixCall.callId);
      return;
    }

    callStore.cancelScheduledClear();

    const peerId = matrixCall.getOpponentMember()?.userId ?? "";
    const { peerAddress, peerName } = await resolvePeerInfo(peerId);
    const isVideo = matrixCall.type === "video";

    const callInfo: CallInfo = {
      callId: matrixCall.callId,
      roomId: matrixCall.roomId,
      peerId,
      peerAddress,
      peerName,
      type: isVideo ? "video" : "voice",
      direction: "incoming",
      status: CallStatus.incoming,
      startedAt: null,
      endedAt: null,
    };

    callStore.setMatrixCall(matrixCall);
    callStore.videoMuted = !isVideo;
    wireCallEvents(matrixCall, "incoming");

    // NOTE: refreshPeerNameAsync is intentionally not scheduled here.
    // The Vue store guard inside the helper checks `activeCall.callId ===
    // callId`, but on the native non-fast-path we deliberately keep
    // activeCall null until answerCall (so the Vue ringer doesn't double
    // up over the native one — see line ~963 below). The refresh is
    // scheduled at each branch where setActiveCall actually runs.

    // Fast-path: the user already tapped Answer on the FCM/push ringer
    // before Matrix even delivered this invite. Don't re-show our own
    // incoming UI (the native ringer would fire a second time and the
    // user sees a confusing "another ring" after the app opens). Skip
    // straight to answering — this is the path that matches what
    // WhatsApp/Telegram do: one tap on Answer transitions the surface
    // directly to the in-call screen.
    const alreadyAccepted = isNative && (await consumePendingAnswerCallId(matrixCall.callId, matrixCall.roomId));
    if (alreadyAccepted) {
      console.log("[call-service] Pre-accepted incoming call, skipping ringer:", matrixCall.callId);
      // Seed activeCall with incoming status so answerCall() sees the
      // right state and the UI has something to bind to. Do NOT pre-set
      // status=connecting here: answerCall has a guard that bails out
      // when it sees a connecting/connected status, assuming another
      // code path already drove the answer. That guard is correct for
      // duplicate-answer races but would cause this intentional fast
      // path to silently skip the actual SDK answer, leaving the
      // caller stuck on "connecting…" forever.
      callStore.setActiveCall(callInfo);
      // Late-arriving profile patch — only schedules a network roundtrip
      // when peerName fell back to the raw address. The store patch will
      // update Vue surfaces (CallStatusBar, CallWindow). The native
      // CallActivity caller-name does NOT refresh from this — it reads
      // its callerName from launchCallUI's Intent extras at start and
      // there's no updateCallerInfo bridge yet. That's a follow-up:
      // patching native surfaces requires a Kotlin-side BroadcastReceiver
      // and is tracked separately from this Session 30 fix.
      if (peerAddress && peerName === peerAddress) {
        refreshPeerNameAsync(matrixCall.callId, peerAddress);
      }
      // Launch the native in-call surface right away. The native
      // CallActivity covers the Vue UI, so the user doesn't see the
      // incoming-ring screen flash through before answerCall() sets
      // status=connecting a moment later.
      NativeWebRTC.launchCallUI({
        callerName: peerName,
        callType: callInfo.type,
        callId: matrixCall.callId,
        direction: "incoming",
      }).catch((e) => console.error("[call-service] launchCallUI failed:", e));
      // Immediately drive the SDK answer flow. This mirrors what the
      // normal user-presses-Answer path does, minus the native ringer
      // detour that we've already satisfied via the push accept.
      void answerCall();
      return;
    }

    // Normal incoming flow — not pre-accepted.
    //
    // On native: the FCM push handler already showed IncomingCallActivity
    // — that's the ONLY ringer the user should see. Do NOT set the Vue
    // activeCall state to `incoming` here because the Vue UI binds to
    // activeCall and would render a SECOND, web-based ringer on top of
    // the native one. We also skip reportIncomingCall, which would just
    // ask Telecom to open yet another incoming call surface. The user's
    // accept/decline from the native ringer will route through
    // CallConnection's callbacks and drive rejectCall() / answerCall()
    // from the existing bridge listeners.
    //
    // On web: render the Vue incoming ringer and play our ringtone.
    if (isNative) {
      // activeCall stays cleared so no Vue ringer. matrixCall is set
      // above so rejectCall()/answerCall() can find it.
      // #645 follow-up: when activeCall is null we have nowhere to patch
      // the resolved name into. The native ringer was launched by the
      // FCM handler with whatever name was in the push payload — fixing
      // that path needs a Kotlin-side updateCallerInfo bridge.
    } else {
      callStore.setActiveCall(callInfo);
      // Web ringer is showing the Vue UI — schedule the late patch so
      // CallStatusBar / IncomingCallModal flip from address to real name
      // once the profile loads. Same conditional as fast-path: skip when
      // resolvePeerInfo already had a hot-cache hit.
      if (peerAddress && peerName === peerAddress) {
        refreshPeerNameAsync(matrixCall.callId, peerAddress);
      }
      playRingtone();
    }

    // Auto-reject after 30s if still incoming (#10)
    clearIncomingTimeout();
    incomingTimeoutId = setTimeout(() => {
      incomingTimeoutId = null;
      if (
        callStore.activeCall?.status === CallStatus.incoming ||
        (isNative && callStore.matrixCall === matrixCall)
      ) {
        rejectCall();
      }
    }, 30_000);
  }

  async function answerCall() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) {
      console.warn("[call-service] answerCall: no matrixCall, bailing");
      return;
    }
    console.log("[call-service] answerCall: begin, callId=" + call.callId);

    // Guard against duplicate invocations. We intentionally allow
    // multiple answerCall() call sites (user tap in UI, native accept
    // event, pre-accepted push path, wait-for-matrix poll) because any
    // of them can realistically fire first, but all of them pass
    // through this check so only the first one actually answers.
    const currentStatus = callStore.activeCall?.status;
    if (currentStatus === CallStatus.connecting || currentStatus === CallStatus.connected) {
      console.log("[call-service] answerCall: already " + currentStatus + ", guard bails");
      return;
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
      unwireCallEvents(call);
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
        void finalizeCall("permission-denied", call.callId);
      }
      return;
    }

    callStore.updateStatus(CallStatus.connecting);

    // Hint stored device IDs (lightweight, sync) — real fix is post-connect
    const client = getClient();
    hintStoredDevices(client);

    // H3: watchdog — if we stay in "connecting" for 30s, tear the call
    // down. onState clears this watchdog whenever status transitions
    // away from connecting; hangup/reject clear it explicitly.
    clearConnectingWatchdog();
    connectingWatchdogId = setTimeout(() => {
      connectingWatchdogId = null;
      if (callStore.activeCall?.status !== CallStatus.connecting) return;
      console.warn("[call-service] answerCall: stuck in connecting for 30s, forcing failed");
      unwireCallEvents(call);
      try {
        call.hangup(CallErrorCode.UserHangup, false);
      } catch { /* ignore */ }
      callStore.updateStatus(CallStatus.failed);
      callStore.scheduleClearCall(2000);
      if (isNative) {
        void finalizeCall("watchdog-timeout", call.callId);
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

      // Non-blocking native UX transitions.
      if (isNative && callStore.activeCall) {
        NativeWebRTC.launchCallUI({
          callerName: callStore.activeCall.peerName,
          callType: callStore.activeCall.type,
          callId: call.callId,
          direction: "incoming",
        }).catch((e) => console.warn("[call-service] launchCallUI failed:", e));
      }

      // Activate native VoIP audio routing after answering. Graceful
      // degradation on failure — never drop the call for a routing hiccup.
      if (isNative) {
        const callType = isVideo ? "video" : "voice";
        nativeCallBridge.startAudioRouting({ callType }).catch((e) => {
          console.warn("[call-service] startAudioRouting failed:", e);
        });
      }
    } catch (e) {
      console.error("[call-service] Failed to answer call:", e);
      useBugReport().open({ context: tRaw("bugReport.ctx.answerCall"), error: e });
      clearConnectingWatchdog();
      unwireCallEvents(call);
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
        void finalizeCall("error", call.callId);
      }
    }
  }

  function rejectCall() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    clearIncomingTimeout();
    clearConnectingWatchdog();
    stopAllSounds();

    try {
      call.reject();
    } catch (e) {
      console.warn("[call-service] reject error:", e);
    }

    // Centralized native cleanup — release audio routing, dismiss UI,
    // close any peer connections that were started during a prior answer
    // attempt. Idempotent on native side; safe even if the router never
    // started for an incoming call that began from ringing.
    if (isNative) {
      void finalizeCall("reject", call.callId);
    }

    unwireCallEvents(call);

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
  }

  function hangup() {
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
      void finalizeCall("hangup", call.callId);
    }

    // Fallback cleanup if SDK doesn't fire Ended event (#11)
    callStore.scheduleClearCall(3000);
  }

  async function toggleMute() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    try {
      const muted = call.isMicrophoneMuted();
      await call.setMicrophoneMuted(!muted);
      callStore.audioMuted = !muted;
    } catch (e) {
      console.error("[call-service] toggleMute error:", e);
    }
  }

  /** Toggle camera — trust SDK, single setLocalVideoMuted call (#2) */
  async function toggleCamera() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    if (toggleCameraLock) {
      console.warn("[call-service] toggleCamera already in progress");
      return;
    }
    toggleCameraLock = true;

    try {
      const wantMuted = !callStore.videoMuted;

      await call.setLocalVideoMuted(wantMuted);
      callStore.videoMuted = wantMuted;

      if (!wantMuted && callStore.activeCall?.type === "voice") {
        callStore.setActiveCall({ ...callStore.activeCall, type: "video" });
      }
      updateFeeds(call);

      // Re-apply saved video device when turning camera back on —
      // SDK may have acquired the default device instead of the saved one
      if (!wantMuted) {
        const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
        if (savedVideo) {
          const newTrack = call.localUsermediaStream?.getVideoTracks()[0];
          const currentId = newTrack?.getSettings()?.deviceId ?? "";
          if (currentId && currentId !== savedVideo) {
            await setVideoDevice(savedVideo);
          }
        }
      }
    } catch (e) {
      console.error("[call-service] toggleCamera error:", e);
    } finally {
      toggleCameraLock = false;
    }
  }

  async function toggleScreenShare() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    try {
      const wasEnabled = callStore.screenSharing;
      const newState = await call.setScreensharingEnabled(!wasEnabled);
      // setScreensharingEnabled returns the actual new state (true=sharing, false=not)
      callStore.screenSharing = newState;
      updateFeeds(call);
    } catch (e) {
      console.error("[call-service] toggleScreenShare error:", e);
      // On error, ensure state reflects reality
      callStore.screenSharing = false;
    }
  }

  /**
   * Switch audio input device mid-call.
   *
   * Bypasses SDK's mediaHandler.setAudioInput which uses {ideal} constraint
   * (browser can silently return the old device). Instead we:
   * 1. getUserMedia with {exact: deviceId}
   * 2. sender.replaceTrack on the peer connection
   * 3. swap the track in the local MediaStream
   * 4. sync mediaHandler's stored input ID
   */
  async function setAudioDevice(deviceId: string) {
    try {
      const call = callStore.matrixCall as MatrixCall | null;
      if (!call) return;

      // 1. Acquire new track with {exact} constraint
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      });
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) {
        newStream.getTracks().forEach(t => t.stop());
        console.error("[call-service] setAudioDevice: no audio track obtained");
        return;
      }

      // 2. Replace track on the WebRTC sender
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pc: RTCPeerConnection | undefined = (call as any).peerConn;
      if (pc) {
        const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (audioSender) {
          await audioSender.replaceTrack(newTrack);
        } else {
          console.warn("[call-service] No audio sender found on peer connection");
        }
      }

      // 3. Swap track in local MediaStream so UI reflects new device
      const localStream = call.localUsermediaStream;
      if (localStream) {
        const oldTrack = localStream.getAudioTracks()[0];
        if (oldTrack) {
          localStream.removeTrack(oldTrack);
          oldTrack.stop();
        }
        localStream.addTrack(newTrack);
      }

      // 4. Sync mediaHandler's stored ID (so future calls use this device)
      const client = getClient();
      const mediaHandler = client?.getMediaHandler?.();
      if (mediaHandler?.restoreMediaSettings) {
        const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
        mediaHandler.restoreMediaSettings(deviceId, savedVideo);
      }

      updateFeeds(call);
    } catch (e) {
      console.error("[call-service] setAudioDevice error:", e);
    }
  }

  /**
   * Switch video input device mid-call.
   *
   * Same bypass as setAudioDevice — uses {exact} constraint directly.
   */
  async function setVideoDevice(deviceId: string) {
    try {
      const call = callStore.matrixCall as MatrixCall | null;
      if (!call) return;

      // 1. Acquire new track with {exact} constraint
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) {
        newStream.getTracks().forEach(t => t.stop());
        console.error("[call-service] setVideoDevice: no video track obtained");
        return;
      }

      // 2. Replace track on the WebRTC sender
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pc: RTCPeerConnection | undefined = (call as any).peerConn;
      if (pc) {
        const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (videoSender) {
          await videoSender.replaceTrack(newTrack);
        } else {
          console.warn("[call-service] No video sender found on peer connection");
        }
      }

      // 3. Swap track in local MediaStream so UI reflects new device
      const localStream = call.localUsermediaStream;
      if (localStream) {
        const oldTrack = localStream.getVideoTracks()[0];
        if (oldTrack) {
          localStream.removeTrack(oldTrack);
          oldTrack.stop();
        }
        localStream.addTrack(newTrack);
      }

      // 4. Sync mediaHandler's stored ID
      const client = getClient();
      const mediaHandler = client?.getMediaHandler?.();
      if (mediaHandler?.restoreMediaSettings) {
        const savedAudio = localStorage.getItem("bastyon_call_audio_device") ?? "";
        mediaHandler.restoreMediaSettings(savedAudio, deviceId);
      }

      updateFeeds(call);
    } catch (e) {
      console.error("[call-service] setVideoDevice error:", e);
    }
  }

  /** Called from native CallActivity video toggle — triggers SDK renegotiation */
  async function setLocalVideoMuted(muted: boolean) {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;
    try {
      await call.setLocalVideoMuted(muted);
      callStore.videoMuted = muted;
      if (!muted && callStore.activeCall?.type === "voice") {
        callStore.setActiveCall({ ...callStore.activeCall, type: "video" });
      }
      updateFeeds(call);
    } catch (e) {
      console.error("[call-service] setLocalVideoMuted error:", e);
    }
  }

  return {
    startCall,
    handleIncomingCall,
    answerCall,
    rejectCall,
    hangup,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    setAudioDevice,
    setVideoDevice,
    setLocalVideoMuted,
  };
}
