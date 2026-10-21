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
import {
  getWebRTCEngine,
  type WebRTCEngine,
} from "@/shared/lib/native-webrtc/webrtc-engine-preference";
import type {
  AudioTimelineEntry,
  InviteThrottleRecord,
  InviteThrottleSnapshot,
  RingAudioRecord,
} from "@/shared/lib/native-calls";

/** Mirror of the call feature's IceSummary; kept here so shared/ owns the envelope shape. */
export interface CallIceDiagnostics {
  total: number;
  relay: number;
  host: number;
  srflx: number;
  selectedPairType: string | null;
  lastIceState: string | null;
  turnServers: number | null;
}

export interface CallTorDiagnostics {
  enabled: boolean;
  connected: boolean;
}

export interface CallDiagnosticsExtras {
  ice: CallIceDiagnostics | null;
  tor: CallTorDiagnostics | null;
}

/**
 * The call feature knows the last connection's ICE facts and the Tor
 * state; this module must not import it (shared → features). The feature
 * registers a provider instead, at wiring time. Null until it does.
 */
type ExtrasProvider = () => Promise<CallDiagnosticsExtras> | CallDiagnosticsExtras;
let extrasProvider: ExtrasProvider | null = null;

export function registerCallDiagnosticsExtras(provider: ExtrasProvider | null): void {
  extrasProvider = provider;
}

const NO_EXTRAS: CallDiagnosticsExtras = { ice: null, tor: null };

async function collectExtras(): Promise<CallDiagnosticsExtras> {
  if (!extrasProvider) return { ...NO_EXTRAS };
  try {
    const extras = await extrasProvider();
    return { ice: extras.ice ?? null, tor: extras.tor ?? null };
  } catch (e) {
    console.warn("[bug-report] call diagnostics extras failed:", e);
    return { ...NO_EXTRAS };
  }
}

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
  /**
   * Which media stack carried the call on this device. Android defaults to
   * `native`; a device switched to `webview` is running the WebView's own
   * WebRTC. Triage needs this to know whether a report says anything about
   * the native engine at all.
   */
  webrtcEngine: WebRTCEngine;
  /**
   * Ordered audio-stack events for the call, oldest first, times relative to
   * the first entry. Android only; empty elsewhere and on older native builds.
   */
  audioTimeline: AudioTimelineEntry[];
  /**
   * The audio state of the last incoming rings, oldest first: the mode the
   * ringtone played in and whether Telecom held the call. Android only.
   */
  ringAudio: RingAudioRecord[];
  /**
   * Relay/host/srflx candidates and the selected pair of the last call on
   * this device, from the call feature's diagnostics. Null when no call
   * has run in this process. Every platform.
   */
  ice: CallIceDiagnostics | null;
  /** Tor mode at report time — calls bypass Tor, so a report should say whether it was on. */
  tor: CallTorDiagnostics | null;
  /**
   * O10: whether Android still grants the full-screen incoming-call surface.
   * False = revoked (Android 14+ sideload), the ringer degrades to a heads-up
   * card. Null off Android, before Android 14, or when the query failed.
   */
  fullScreenIntentAllowed: boolean | null;
}

export const EMPTY_CALL_DIAGNOSTICS: BugReportCallDiagnostics = {
  audioMode: "MODE_NORMAL",
  isSpeakerOn: false,
  isBtScoOn: false,
  inviteHistory: [],
  expiredInviteCount: 0,
  webrtcEngine: "native",
  audioTimeline: [],
  ringAudio: [],
  ice: null,
  tor: null,
  fullScreenIntentAllowed: null,
};

export async function collectCallDiagnostics(): Promise<BugReportCallDiagnostics> {
  // ICE and Tor facts are platform-independent; a web report carries them too.
  const extras = await collectExtras();
  if (!isNative) return { ...EMPTY_CALL_DIAGNOSTICS, ...extras };

  // Read before the awaits below: it is a synchronous localStorage lookup and
  // must be reported even if the native queries that follow all fail.
  const webrtcEngine = getWebRTCEngine();

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
  let audioTimeline: AudioTimelineEntry[] = [];
  let ringAudio: RingAudioRecord[] = [];
  let inviteHistory: InviteThrottleRecord[] = [];
  let fullScreenIntentAllowed: boolean | null = null;
  if (isAndroid) {
    fullScreenIntentAllowed = await import("@/shared/lib/push/push-data-plugin")
      .then(({ PushData }) => PushData.getFullScreenIntentStatus())
      .then((status) => (status.manageable ? status.allowed : null))
      .catch(() => null);
    audioTimeline = await nativeCallBridge.getAudioTimeline().catch(() => []);
    ringAudio = await nativeCallBridge.getRingAudioLog().catch(() => []);
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
    webrtcEngine,
    audioTimeline,
    ringAudio,
    ...extras,
    fullScreenIntentAllowed,
  };
}
