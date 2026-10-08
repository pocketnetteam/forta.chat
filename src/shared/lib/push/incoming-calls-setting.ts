import { APP_NAME } from "@/shared/config";
import { isNative } from "@/shared/lib/platform";
import { PushData } from "./push-data-plugin";

/**
 * "Incoming calls" switch (forta-bugs#1388). Off: Forta does not ring for a
 * call at all — no ringer, no reject — so the same account keeps ringing in
 * Bastyon and on other devices. The caller sees an ordinary unanswered call.
 *
 * JS reads it for calls that arrive through /sync or a forwarded push; native
 * keeps a copy (SharedPreferences / UserDefaults) for pushes that wake a dead
 * app: the FCM service drops the invite, PushKit reports it and ends it at
 * once (iOS demands a CallKit report for every VoIP push).
 */
const STORAGE_KEY = `${APP_NAME}:incoming_calls_enabled`;

/** Default on: a missing or unreadable value keeps calls ringing. */
export function isIncomingCallsEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Store the switch and hand it to native. Never throws. */
export async function setIncomingCallsEnabled(enabled: boolean): Promise<void> {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch (e) {
    console.warn("[incoming-calls] localStorage write failed:", e);
  }
  await syncIncomingCallsSettingToNative();
}

/**
 * Native's copy follows JS; called on change and at start, in case it was lost.
 * Only a stored choice is sent: with no value (a fresh install, or WebView
 * storage purged by the OS) the default "on" would overwrite a native "off"
 * and Forta would ring again without the user touching the switch. Never throws.
 */
export async function syncIncomingCallsSettingToNative(): Promise<void> {
  if (!isNative) return;
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === null) {
      // No JS value: take native's copy instead of pushing the default (C05).
      await resolveIncomingCallsEnabled();
      return;
    }
  } catch {
    return;
  }
  try {
    await PushData.setIncomingCallsEnabled({ enabled: isIncomingCallsEnabled() });
  } catch (e) {
    console.warn("[incoming-calls] native sync failed:", e);
  }
}

/** How long an incoming call waits for native's copy before it rings anyway. */
const NATIVE_READ_TIMEOUT_MS = 500;
let nativeChoice: Promise<boolean | null> | null = null;

/** Native's copy of the switch, read once per process; null when unavailable. */
function readNativeChoice(): Promise<boolean | null> {
  if (!isNative) return Promise.resolve(null);
  if (nativeChoice) return nativeChoice;
  const attempt = Promise.race([
    PushData.getIncomingCallsEnabled()
      .then((r) => (typeof r?.enabled === "boolean" ? r.enabled : null))
      .catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), NATIVE_READ_TIMEOUT_MS)),
  ]);
  nativeChoice = attempt;
  // A timeout or a failure is not native's answer: the next call asks again
  // instead of ringing on the default for the rest of the process.
  void attempt.then((choice) => {
    if (choice === null && nativeChoice === attempt) nativeChoice = null;
  });
  return attempt;
}

/**
 * The switch for a call that is about to ring. C05 (calls review 2026-10-04):
 * with WebView storage purged JS defaulted to on while native still held
 * "off", so a call arriving through /sync rang although the user had turned
 * calls off. A stored JS value wins; without one native's copy is taken and
 * stored, and the default "on" applies only when neither has a choice.
 * Never throws.
 */
export async function resolveIncomingCallsEnabled(): Promise<boolean> {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored !== "false";
  } catch {
    return true;
  }
  const native = await readNativeChoice();
  if (native === null) return true;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(native));
  } catch {
    /* best effort: the next call asks the cached native value again */
  }
  return native;
}

/** Test-only: forget the cached native read. */
export function __resetIncomingCallsSettingForTests(): void {
  nativeChoice = null;
}
