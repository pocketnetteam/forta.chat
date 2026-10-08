/**
 * Outgoing calls: the Matrix-ready wait, the re-entry lock and call placement. Split out of
 * call-service.ts; each function reads the call store itself.
 */
import { createNewMatrixCall, type MatrixCall } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import { getMatrixClientService } from "@/entities/matrix";
import { ensureRoomMembers } from "@/entities/matrix/model/ensure-room-members";
import { CallStatus, type CallInfo, type CallType, useCallStore } from "@/entities/call";
import { ensureCallHangupContextProvider } from "./call-hangup-context";
import { stopAllSounds } from "./call-sounds";
import { checkOtherTabHasCall } from "./call-tab-lock";

import { isNative } from "@/shared/lib/platform";
import { useBugReport } from "@/features/bug-report";
import { tRaw } from "@/shared/lib/i18n";
import { useToast } from "@/shared/lib/use-toast";
import { nativeCallBridge } from "@/shared/lib/native-calls";
import { PermissionDeniedError, callPermissionError, ensureCallPermissions } from "./permissions";
import { FINALIZE_SETTLE_WAIT_MS, finalizeCall, waitForFinalizeSettled } from "./finalize-call";
import { waitUntil } from "@/shared/lib/wait-until";
import { maybeWarnLegacyWebView } from "./call-engine-setup";
import { CALL_MEMBERS_TIMEOUT_MS, refreshPeerNameAsync, resolvePeerInfo } from "./call-peer-info";
import { warnIfCallBypassesTor } from "./call-tor-facts";
import { hintStoredDevices } from "./call-media";
import { releaseLocalMedia, unwireCallEvents, wireCallEvents } from "./call-events";
import { launchNativeCallScreen } from "./call-native-screen";
import { hangup } from "./call-answer";

/**
 * How long a dial waits for Matrix after a cold start. The chat list is up
 * (Dexie-first) seconds before `matrixReady` flips, and a tap in that window
 * used to find no client and drop the call without a word. Ten seconds
 * covers the usual connect; a degraded re-login (26 s seen once on the test
 * phone) gets a "try again in a moment" instead of a half-minute of nothing.
 */
export const MATRIX_READY_WAIT_MS = 10_000;

// ---------------------------------------------------------------------------
// Outgoing-call re-entry lock (WEE-49 / forta-bugs#460)
// ---------------------------------------------------------------------------
//
// The status-based `callStore.isInCall` guard inside startCall bails when
// an active call already exists, but the first `await` (ensureCallPermissions)
// opens a window of several hundred milliseconds during which callStore is
// still empty. A double-tap on the call button — or a JS event re-emit
// from the call message timeline — passes the guard twice and creates two
// MatrixCall objects, which the SDK then surfaces as two outgoing dialogs
// (forta-bugs#460). The synchronous flag closes that window; resetting it
// in `finally` keeps it from leaking across calls.
//
// Module-scope is safe: the store already enforces a single active call per
// process, so there's at most one startCall in flight at any time.
let outgoingCallInProgress = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True once Matrix is ready to place a call, waiting up to
 * MATRIX_READY_WAIT_MS for it. Tells the user both that it is waiting and
 * when it gave up — a dial that vanishes silently is the bug this closes.
 *
 * The auth store is imported lazily: `entities/auth` imports this module
 * for the native call bridge, and a static import back would pull the
 * whole store graph into every consumer of call-service.
 */
async function waitForMatrixReady(): Promise<boolean> {
  const { message, toast, close } = useToast();
  try {
    const { useAuthStore } = await import("@/entities/auth");
    const auth = useAuthStore();
    if (auth.matrixReady) return true;

    console.warn("[call-service] Matrix not ready — waiting up to", MATRIX_READY_WAIT_MS, "ms");
    const waitingText = tRaw("call.info.waitingForServer");
    toast(waitingText, "info", MATRIX_READY_WAIT_MS);
    const ready = await waitUntil(() => auth.matrixReady, MATRIX_READY_WAIT_MS);
    if (ready) {
      // The toast is one global slot: close only our own text, not whatever
      // another feature may have shown during the wait.
      if (message.value === waitingText) close();
      return true;
    }
    console.error("[call-service] Matrix not ready after wait — call dropped");
  } catch (e) {
    // Every caller fires startCall without awaiting it, so an exception
    // here would be an unhandled rejection and the dial would vanish
    // silently — the very bug this wait exists to close.
    console.error("[call-service] readiness wait failed — call dropped:", e);
  }
  toast(tRaw("call.error.matrixNotReady"), "error", 5000);
  return false;
}

export async function startCall(roomId: string, type: CallType) {
  const callStore = useCallStore();
  // Before the call reaches native code: the swipe hangup is read from the
  // page while the call is dialled (call-hangup-context.ts).
  ensureCallHangupContextProvider();
  // `hasLiveCall`, not `isInCall`: on Android an incoming call rings
  // through Telecom with no CallInfo written yet, so `isInCall` is false
  // for the whole ring and the call buttons stay live. Dialling from that
  // screen used to overwrite the single MatrixCall slot, orphaning the
  // call that was ringing — the user answered a call nothing was
  // listening to any more (#1183).
  if (callStore.hasLiveCall) {
    console.warn("[call-service] Already in a call");
    return;
  }
  // WEE-49 / forta-bugs#460: synchronous re-entry guard for outgoing calls.
  // The `isInCall` check above only catches the case where a previous
  // call already wrote `setActiveCall`; a fast double-tap (or a JS-event
  // re-emit from the call-message timeline) can pass it twice before the
  // first invocation reaches that write. Set the flag immediately and
  // clear it in `finally` so a failed dial does not block a retry — and
  // also clear it as soon as `setActiveCall` ran inside the inner flow,
  // so a slow placeVoiceCall does not keep the lock past the actual
  // double-tap window (`isInCall` protects re-entry after that point).
  if (outgoingCallInProgress) {
    console.warn("[call-service] startCall ignored — outgoing call already in progress");
    return;
  }
  outgoingCallInProgress = true;

  try {
    // Right after a cold start the buttons are live before Matrix is.
    // Wait under the lock so a second tap does not queue a second dial,
    // and before the mic preflight so nothing is captured for a call
    // that may not happen.
    if (!(await waitForMatrixReady())) return;
    // `hasLiveCall` drops the moment the previous call ends, while its
    // finalize is still walking the native steps — the service stop, the
    // audio reset, closeAllPeerConnections — all of them process-wide. Let
    // it finish, or they land on the call being dialled.
    if (!(await waitForFinalizeSettled(FINALIZE_SETTLE_WAIT_MS))) {
      console.warn("[call-service] previous call still finalizing after", FINALIZE_SETTLE_WAIT_MS, "ms — dialling anyway");
    }
    if (callStore.hasLiveCall) {
      console.warn("[call-service] a call arrived while waiting for Matrix — not dialling");
      return;
    }
    await startCallInner(roomId, type);
  } finally {
    outgoingCallInProgress = false;
  }
}

// Called from `startCallInner` once the call has been registered on the
// store; after this point `isInCall` takes over the dedup duty so we can
// release the synchronous lock early. Safe to call multiple times.
function releaseOutgoingLock(): void {
  outgoingCallInProgress = false;
}

async function startCallInner(roomId: string, type: CallType) {
  const callStore = useCallStore();
  const otherTabActive = await checkOtherTabHasCall();
  if (otherTabActive) {
    console.warn("[call-service] Another tab already has an active call");
    return;
  }

  callStore.cancelScheduledClear();
  // The cancelled clear was the only reset of the last call's mute, video,
  // minimized and timer fields; without it this call starts with them.
  if (!callStore.hasLiveCall) callStore.clearCall();

  // forta-bugs#497 / WEE-53: warn up-front when an outdated WebView is about
  // to drive a call. Previously this only surfaced if a mid-call network
  // change triggered the restartIce skip — but most legacy-device failures
  // happen before any handover, so the user never saw the hint. One-shot
  // guard + native exclusion live inside maybeWarnLegacyWebView.
  maybeWarnLegacyWebView();

  // `matrixReady` was true a moment ago; the client can still be gone
  // (logout or account switch racing the dial). Check before the mic
  // preflight so no stream is captured for a call that cannot be placed,
  // and say so — this branch used to return without a word.
  const matrixService = getMatrixClientService();
  const client = matrixService.client;
  if (!client) {
    console.error("[call-service] No Matrix client");
    useToast().toast(tRaw("call.error.matrixNotReady"), "error", 5000);
    return;
  }

  // A lazy-loaded member list may not hold the peer yet. Loaded alongside
  // the mic preflight and awaited before the call object exists, so a slow
  // /members never leaves a created call without state or UI.
  const membersReady = ensureRoomMembers(client.getRoom(roomId), { timeoutMs: CALL_MEMBERS_TIMEOUT_MS })
    .catch((e) => console.warn("[call-service] startCall: room members not loaded:", e));

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

  // SDK may expose supportsVoip() or canSupportVoip; prefer method call
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supportsVoip = typeof (client as any).supportsVoip === "function"
    ? (client as any).supportsVoip()
    : (client as any).canSupportVoip === true;

  await membersReady;
  const call = createNewMatrixCall(client, roomId);
  if (!call) {
    console.error("[call-service] createNewMatrixCall returned null — WebRTC not available (secure context + RTCPeerConnection required)");
    return;
  }
  void warnIfCallBypassesTor();
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
  // WEE-49: hand off the dedup duty to `callStore.isInCall` now that the
  // call is registered. The outer `finally` is a safety net but holding
  // the sync lock through placeVoiceCall (which may take >1s on a slow
  // network) would block legitimate dial retries after a hangup if any
  // dialing path failed to complete cleanly.
  releaseOutgoingLock();
  wireCallEvents(call, "outgoing");

  // Late-arriving profile patch — only schedule when resolvePeerInfo's
  // 500ms timer fell through to the raw address (peerName === peerAddress
  // means no profile name was found). Skipping the no-op refresh in the
  // hot-cache path avoids a duplicate dedupe-pool round trip and a
  // redundant store write.
  if (peerAddress && peerName === peerAddress) {
    refreshPeerNameAsync(call.callId, peerAddress);
  }

  // WEE-54 / forta-bugs#866: the local ringback tone is NOT started here.
  // It used to play synchronously at this point — before placeVoiceCall()
  // even ran — so "гудки" sounded during local media setup and even when
  // the invite never reached the server. It is now gated on the SDK's
  // InviteSent state inside wireCallEvents() so it only plays once we are
  // actually dialing the peer.

  // Register outgoing call with Android ConnectionService + launch native UI
  if (isNative) {
    import('@/shared/lib/native-calls').then(({ nativeCallBridge }) => {
      nativeCallBridge.reportOutgoingCall({
        callId: call.callId,
        callerName: peerName,
        hasVideo: type === 'video',
      });
    }).catch(() => {});
    launchNativeCallScreen({
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
    // WEE-16: the bridge now retries with a backoff and never rejects
    // — failures are logged inside the bridge with full attempt count.
    // We do not await it: starting audio routing is non-blocking for
    // the dial-tone UX. Not for a call hung up while it was being placed:
    // its teardown already ran, and the routing would outlive it.
    if (isNative && call.callHasEnded?.() !== true) {
      void nativeCallBridge.startAudioRouting({ callType: type });
    }
  } catch (e) {
    console.error("[call-service] Failed to place call:", e);
    useBugReport().open({ context: tRaw("bugReport.ctx.placeCall"), error: e });
    stopAllSounds();
    unwireCallEvents();
    // WEE-89: placeCall may have run getUserMedia before throwing — release
    // any acquired camera/mic tracks so they aren't left captured.
    releaseLocalMedia(call);
    callStore.updateStatus(CallStatus.failed);
    callStore.scheduleClearCall(2000);
    // H1/H7 + Session 23: native side of startAudioRouting may have
    // already bumped the phone into MODE_IN_COMMUNICATION (it is queued
    // sync with placeCall). finalizeCall always runs the full teardown
    // chain (stop routing → report ended → dismiss UI → close PCs);
    // each step is idempotent on the native side, so calling it when
    // startAudioRouting never ran is just a no-op + one warn log.
    if (isNative) {
      void finalizeCall("error", call.callId, call.roomId);
    }
  }
}

/** True while a dial is being set up; the incoming path reads it to answer a crossing invite as busy. */
export function isOutgoingCallInProgress(): boolean {
  return outgoingCallInProgress;
}
