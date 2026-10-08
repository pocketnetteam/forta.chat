/**
 * Incoming calls: the invite gate (busy, other tab, pending native decisions, incoming-calls
 * setting) and the ringer setup. Split out of call-service.ts; reads the call store itself.
 */
import type { MatrixCall } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import { CallStatus, type CallInfo, useCallStore } from "@/entities/call";
import { ensureCallHangupContextProvider } from "./call-hangup-context";
import { playRingtone } from "./call-sounds";
import { checkOtherTabHasCall } from "./call-tab-lock";
import { isNative } from "@/shared/lib/platform";
import { consumePendingAnswerCallId, consumePendingRejectCallId, nativeCallBridge } from "@/shared/lib/native-calls";
import { finalizeCall } from "./finalize-call";
import { isIncomingCallsEnabled } from "@/shared/lib/push/incoming-calls-setting";
import { clearIncomingCallSeen, isIncomingCallSeen, markIncomingCallSeen } from "./incoming-call-dedup";
import { refreshPeerNameAsync, resolvePeerInfo } from "./call-peer-info";
import { armIncomingTimeout, clearIncomingTimeout } from "./call-timers";
import { unwireCallEvents, wireCallEvents } from "./call-events";
import { launchNativeCallScreen } from "./call-native-screen";
import { answerCall, rejectCall } from "./call-answer";
import { isOutgoingCallInProgress } from "./call-outgoing";

/**
 * True when the SDK has already terminated this call.
 *
 * `CallState.Ended` is the state the SDK moves an expired invite into: its
 * lifetime timer is armed with `lifetime - localAge`, which is negative for
 * an invite the homeserver retained, so it fires on the tick right after
 * `Call.incoming`. Read defensively — `state` is not in every SDK version's
 * public surface and a missing one must not stop a legitimate call ringing.
 */
/**
 * Reject an invite we will not ring. The SDK throws unless the call is still
 * ringing, and its expiry timer can end it during the awaits before this
 * point; the throw escaped handleIncomingCall as an unhandled rejection and
 * skipped the dedup release after it.
 */
function rejectQuietly(call: MatrixCall): void {
  try {
    call.reject();
  } catch (e) {
    console.warn("[call-service] reject of an invite we will not ring failed:", e);
  }
}

function isSdkCallEnded(call: MatrixCall): boolean {
  const state = (call as unknown as { state?: string }).state;
  return state === "ended";
}

/** The invite whose setup is running (C01); a second invite meanwhile is answered busy. */
let incomingSetupCallId: string | null = null;

export async function handleIncomingCall(matrixCall: MatrixCall) {
  const callStore = useCallStore();
  ensureCallHangupContextProvider();
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

  // "Incoming calls" off (#1388): no ringer and no reject, so Bastyon and
  // the account's other devices keep ringing. The SDK drops the call when
  // the caller hangs up or the invite expires.
  if (!isIncomingCallsEnabled()) {
    console.info("[call-service] incoming call ignored, incoming calls are off:", matrixCall.callId);
    return;
  }

  // C01 (calls review 2026-10-04): the setup below awaits pending native
  // decisions, the other-tab check and the peer lookup. A second invite that
  // arrived in that window found the slot empty and overwrote the first one.
  // Reserve the setup synchronously; another invite meanwhile is busy.
  if (incomingSetupCallId !== null && incomingSetupCallId !== matrixCall.callId) {
    console.log("[call-service] handleIncomingCall: another invite is being set up, rejecting as busy");
    rejectQuietly(matrixCall);
    if (matrixCall.callId) clearIncomingCallSeen(matrixCall.callId);
    return;
  }
  incomingSetupCallId = matrixCall.callId;
  try {
    await setUpIncomingCall(matrixCall);
  } finally {
    if (incomingSetupCallId === matrixCall.callId) incomingSetupCallId = null;
  }
}

/** The part of {@link handleIncomingCall} that runs under the setup reservation (C01). */
async function setUpIncomingCall(matrixCall: MatrixCall) {
  const callStore = useCallStore();

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

  // We are dialling ourselves: the outgoing call has not reached the slot
  // yet (it does so after several awaits), so hasLiveCall below misses it,
  // and the incoming call took the slot and stranded the dial. Busy.
  if (isOutgoingCallInProgress()) {
    console.log("[call-service] handleIncomingCall: dialling out, rejecting as busy");
    rejectQuietly(matrixCall);
    if (matrixCall.callId) clearIncomingCallSeen(matrixCall.callId);
    return;
  }

  if (callStore.hasLiveCall) {
    console.log("[call-service] handleIncomingCall: already in call, rejecting");
    // Deliberately NOT finalizeCall() here, unlike the expired-invite
    // ("sdk-ended") bail-out later in this function. Skipping it also skips
    // the pending-marker retire, which is fine only because Telecom answers
    // a second incoming call with BUSY while one is established — no
    // CallConnection is constructed, so no marker is ever written for it.
    // Revisit this if busy-handling ever starts creating a connection:
    // finalize is global teardown (audio mode -> NORMAL, dismissCallUI,
    // closeAllPeerConnections), so running it for the *incoming* call would
    // hang up the conversation the user is currently having. While a call is
    // established FCM puts no native ringer up for this second caller: it
    // reads the Telecom slot first and only forwards the push here. A call
    // that still rings is SecondRingPolicy's case — see
    // docs/call-bugs-needing-you.md, "Второй входящий во время разговора".
    rejectQuietly(matrixCall);
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
    rejectQuietly(matrixCall);
    // Same rationale as the isInCall branch: ownership of the call is
    // delegated to the other tab — releasing our dedup slot lets a
    // future invite ring through normally if that tab closes.
    if (matrixCall.callId) clearIncomingCallSeen(matrixCall.callId);
    return;
  }

  callStore.cancelScheduledClear();
  // The previous call's state stays until its scheduled clear, which was
  // just cancelled: reset it, or this call is answered with that call's
  // type, peer and id (the native path skips setActiveCall until answer)
  // and starts muted or minimized because that call was.
  if (!callStore.hasLiveCall && callStore.matrixCall !== matrixCall) {
    callStore.clearCall();
  } else if (callStore.activeCall && callStore.activeCall.callId !== matrixCall.callId && !callStore.isInCall) {
    callStore.activeCall = null;
  }

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

  // C01: a dial or another call may have taken the slot during the awaits above.
  if (isOutgoingCallInProgress() || (callStore.hasLiveCall && callStore.matrixCall !== matrixCall)) {
    console.log("[call-service] handleIncomingCall: the slot was taken during setup, rejecting as busy");
    rejectQuietly(matrixCall);
    if (matrixCall.callId) clearIncomingCallSeen(matrixCall.callId);
    return;
  }

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
  // The SDK ends a call whose invite is past its lifetime; its expiry
  // timer can fire during the awaits above, before wireCallEvents, so no
  // State event will ever report it.
  const dropEndedInvite = () => {
    console.warn(
      "[call-service] incoming call already ended by the SDK (expired invite) — not ringing:",
      matrixCall.callId,
    );
    if (matrixCall.callId) clearIncomingCallSeen(matrixCall.callId);
    // Through finalizeCall like every other termination path: the native
    // side may already be ringing (FCM usually wins this race, which is how
    // a retained invite gets here in the first place), and only finalizeCall
    // releases the Telecom connection and dismisses that ringer. Nulling the
    // Pinia slot alone is invisible to native — the phone would keep ringing
    // for a call that is already over.
    unwireCallEvents();
    if (isNative) void finalizeCall("sdk-ended", matrixCall.callId, matrixCall.roomId);
    callStore.setMatrixCall(null);
  };

  const alreadyAccepted = isNative && (await consumePendingAnswerCallId(matrixCall.callId, matrixCall.roomId));
  if (alreadyAccepted) {
    // Accepted on the push ringer, but the invite expired before the app
    // got here: answering it would leave an "incoming" CallInfo that no
    // event ever ends — isInCall stuck true, every later call "busy".
    if (isSdkCallEnded(matrixCall)) {
      dropEndedInvite();
      return;
    }
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
    launchNativeCallScreen({
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
  // On native: the FCM push handler is the *primary* ringer surface,
  // but the race below has bitten users hard (WEE-31 follow-up):
  //   - Push handler can only fire when the FCM message arrives first.
  //   - When the app is in the foreground, Matrix /sync wins the race
  //     against FCM and `handleIncomingCall` fires *before* the push
  //     handler. The push handler then no-ops (already-known callId).
  //   - Net result: no ringer surface is shown, the user hears nothing,
  //     the caller is stuck on "connecting" until their own SDK timeout.
  //
  // Solution: ask the native bridge to ensure the ringer surface is
  // visible. `ensureIncomingCallVisible` is idempotent — it's a no-op
  // when IncomingCallActivity or the Telecom CallConnection is already
  // up (push-first path), and launches the activity when neither is
  // (sync-first path). Vue activeCall stays cleared either way so we
  // don't get a duplicate Vue ringer on top of the native one.
  //
  // On web: render the Vue incoming ringer and play our ringtone.
  //
  // Last check before any ringer: the SDK ends a call whose invite is
  // already past its lifetime, and a homeserver that retained the invite
  // while FCM was degraded delivers exactly that on the next /sync — the
  // SDK's expiry timer runs a tick after Call.incoming, so by the time the
  // awaits above have resolved it has usually already fired. Ringing for a
  // call the SDK has ended is what "a call came in from that account seven
  // minutes later, and there was no call" looks like from the outside
  // (#958, #928).
  if (isSdkCallEnded(matrixCall)) {
    dropEndedInvite();
    return;
  }

  if (isNative) {
    // activeCall stays cleared so no Vue ringer. matrixCall is set
    // above so rejectCall()/answerCall() can find it.
    // #645 follow-up: when activeCall is null we have nowhere to patch
    // the resolved name into. The native ringer was launched by the
    // FCM handler with whatever name was in the push payload — fixing
    // that path needs a Kotlin-side updateCallerInfo bridge.
    void nativeCallBridge.ensureIncomingCallVisible({
      callId: matrixCall.callId,
      callerName: peerName,
      roomId: matrixCall.roomId ?? "",
      hasVideo: callInfo.type === "video",
    });
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
  armIncomingTimeout(() => {
    if (
      callStore.activeCall?.status === CallStatus.incoming ||
      (isNative && callStore.matrixCall === matrixCall)
    ) {
      rejectCall();
    }
  }, 30_000);
}
