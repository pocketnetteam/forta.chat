/**
 * Session 25 / S3-S4: collect call-related diagnostics for the bug-report
 * envelope. Lets us split S1 (accept-crash), S3 (FCM throttle), and S4
 * (stale invite) when triaging user reports without asking them to
 * reproduce.
 *
 * Pulls:
 *   - current AudioManager mode / speakerphone / BT SCO state (both
 *     platforms; iOS surfaces .playAndRecord-as-MODE_IN_COMMUNICATION
 *     translation via IOSCallAudio.getStatus, see Step 6 Task 4).
 *   - last 5 FCM `m.call.invite` records, ANDROID ONLY. iOS uses PushKit,
 *     which is real-time and not subject to FCM data-message throttling;
 *     the metric does not apply and we skip both the native call AND the
 *     `inviteHistory` block in the resulting envelope.
 *
 * Always non-throwing — a diagnostic collection failure must NEVER block
 * the bug report itself.
 */

import { isAndroid, isNative } from "@/shared/lib/platform";
import type {
  InviteThrottleRecord,
  InviteThrottleSnapshot,
} from "@/shared/lib/native-calls";

export interface BugReportCallDiagnostics {
  /** AudioManager.mode as a string ("MODE_NORMAL", "MODE_IN_COMMUNICATION", ...). */
  audioMode: string;
  isSpeakerOn: boolean;
  isBtScoOn: boolean;
  /**
   * Last 5 FCM `m.call.invite` records, oldest first. Always empty on
   * iOS — see {@link collectCallDiagnostics} above for the rationale.
   */
  inviteHistory: InviteThrottleRecord[];
  /** Convenience: how many of the recorded invites were already expired on arrival. */
  expiredInviteCount: number;
}

export const EMPTY_CALL_DIAGNOSTICS: BugReportCallDiagnostics = {
  audioMode: "MODE_NORMAL",
  isSpeakerOn: false,
  isBtScoOn: false,
  inviteHistory: [],
  expiredInviteCount: 0,
};

export async function collectCallDiagnostics(): Promise<BugReportCallDiagnostics> {
  if (!isNative) return { ...EMPTY_CALL_DIAGNOSTICS };

  // Lazy import — the bug-report module loads on web too, where this
  // path is dead weight. Avoid pulling the native plugin graph until we
  // know we're going to query it.
  const { nativeCallBridge } = await import("@/shared/lib/native-calls");

  const audioStatus = await nativeCallBridge.getAudioStatus().catch(() => ({
    mode: "MODE_NORMAL",
    isSpeakerOn: false,
    isBtScoOn: false,
  }));

  // Android-only: skip the FCM throttle snapshot on iOS. PushKit
  // delivery latency is reported separately if/when we add a
  // BugReportVoipDiagnostics block. The bridge already short-circuits
  // this on non-Android, but the explicit `if (!isAndroid)` here keeps
  // the bug-report envelope shape obvious to triagers reading the JSON.
  let inviteHistory: InviteThrottleRecord[] = [];
  if (isAndroid) {
    const inviteSnapshot: InviteThrottleSnapshot = await nativeCallBridge
      .getInviteThrottleSnapshot()
      .catch(() => ({ records: [] }));
    inviteHistory = Array.isArray(inviteSnapshot.records)
      ? inviteSnapshot.records
      : [];
  }

  return {
    audioMode: audioStatus.mode,
    isSpeakerOn: audioStatus.isSpeakerOn,
    isBtScoOn: audioStatus.isBtScoOn,
    inviteHistory,
    expiredInviteCount: inviteHistory.filter((r) => r.expired).length,
  };
}
