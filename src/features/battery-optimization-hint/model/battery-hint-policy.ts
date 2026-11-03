/**
 * Battery-optimization hint (docs/plans/2026-10-10-missed-push-calls.md, T3).
 *
 * With the app closed, Android's battery optimization (Doze, App Standby) may
 * hold back a call push until the invite is over: the call never rings. An app
 * exempted by the user gets its pushes on time. The hint asks for that once
 * after sign-in, and again at most once every 30 days, only on Android, only
 * while incoming calls are on and the app is not exempt yet. The user can turn
 * the reminder off in the notification settings.
 */

export const BATTERY_HINT_REPEAT_MS = 30 * 24 * 60 * 60 * 1000;

export interface BatteryHintInput {
  /** Native Android app. */
  isAndroidNative: boolean;
  /** Signed in with a working Matrix session. */
  signedIn: boolean;
  /** The "Incoming calls" switch (#1388). */
  incomingCallsEnabled: boolean;
  /** PowerManager.isIgnoringBatteryOptimizations(); null while unknown. */
  ignoringOptimizations: boolean | null;
  /** The user turned the reminder off. */
  disabled: boolean;
  /** When the hint was last shown (ms), null when never. */
  lastShownAt: number | null;
  now: number;
}

export function shouldShowBatteryHint(input: BatteryHintInput): boolean {
  if (!input.isAndroidNative || !input.signedIn || !input.incomingCallsEnabled || input.disabled) return false;
  // Unknown is not "optimized": no hint without an answer from Android.
  if (input.ignoringOptimizations !== false) return false;
  if (input.lastShownAt !== null && input.now - input.lastShownAt < BATTERY_HINT_REPEAT_MS) return false;
  return true;
}
