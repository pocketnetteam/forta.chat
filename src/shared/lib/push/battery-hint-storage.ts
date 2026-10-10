/**
 * Local state of the battery-optimization hint. Per device only; a storage
 * that throws (private mode, quota) reads as "never shown, reminder on" and
 * drops the write — the hint is a reminder, not a record.
 */
const LAST_SHOWN_KEY = "forta.batteryHint.lastShownAt";
const DISABLED_KEY = "forta.batteryHint.disabled";

export function readBatteryHintLastShownAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_SHOWN_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeBatteryHintLastShownAt(at: number): void {
  try {
    localStorage.setItem(LAST_SHOWN_KEY, String(at));
  } catch (e) {
    console.warn("[battery-hint] cannot store the last shown time:", e);
  }
}

export function isBatteryHintDisabled(): boolean {
  try {
    return localStorage.getItem(DISABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setBatteryHintDisabled(disabled: boolean): void {
  try {
    if (disabled) localStorage.setItem(DISABLED_KEY, "1");
    else localStorage.removeItem(DISABLED_KEY);
  } catch (e) {
    console.warn("[battery-hint] cannot store the reminder switch:", e);
  }
}
