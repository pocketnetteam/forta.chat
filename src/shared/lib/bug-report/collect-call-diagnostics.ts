/**
 * Session 25 / S3-S4: collect call-related diagnostics for the bug-report
 * envelope. Lets us split S1 (accept-crash), S3 (FCM throttle), and S4
 * (stale invite) when triaging user reports without asking them to
 * reproduce.
 *
 * Pulls:
 *   - last 5 FCM `m.call.invite` records (delivery latency + expiry)
 *   - current AudioManager mode / speakerphone / BT SCO state
 *
 * Always non-throwing — a diagnostic collection failure must NEVER block
 * the bug report itself.
 */

import { isNative } from "@/shared/lib/platform";
import type {
  InviteThrottleRecord,
  InviteThrottleSnapshot,
} from "@/shared/lib/native-calls";

export interface BugReportCallDiagnostics {
  /** AudioManager.mode as a string ("MODE_NORMAL", "MODE_IN_COMMUNICATION", ...). */
  audioMode: string;
  isSpeakerOn: boolean;
  isBtScoOn: boolean;
  /** Last 5 FCM `m.call.invite` records, oldest first. */
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

  const inviteSnapshot: InviteThrottleSnapshot = await nativeCallBridge
    .getInviteThrottleSnapshot()
    .catch(() => ({ records: [] }));

  const inviteHistory = Array.isArray(inviteSnapshot.records)
    ? inviteSnapshot.records
    : [];

  return {
    audioMode: audioStatus.mode,
    isSpeakerOn: audioStatus.isSpeakerOn,
    isBtScoOn: audioStatus.isBtScoOn,
    inviteHistory,
    expiredInviteCount: inviteHistory.filter((r) => r.expired).length,
  };
}
