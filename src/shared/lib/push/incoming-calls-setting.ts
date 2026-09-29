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

/** Native's copy follows JS; called on change and at start, in case it was lost. Never throws. */
export async function syncIncomingCallsSettingToNative(): Promise<void> {
  if (!isNative) return;
  try {
    await PushData.setIncomingCallsEnabled({ enabled: isIncomingCallsEnabled() });
  } catch (e) {
    console.warn("[incoming-calls] native sync failed:", e);
  }
}
