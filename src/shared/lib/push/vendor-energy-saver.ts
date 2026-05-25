/**
 * WEE-44 / forta-bugs#732, #766: vendor energy-saver detection.
 *
 * Certain Android OEMs apply aggressive background-process killing on top
 * of stock Doze. Even with a healthy FCM token and a registered Matrix
 * pusher, messages may arrive minutes late — or never — until the user
 * adds Forta to the per-vendor "no battery optimization / autostart"
 * allow-list.
 *
 * This module classifies the device by `Build.MANUFACTURER` so the UI
 * layer can surface a one-time hint with the right instructions per
 * vendor. We deliberately keep this as a pure classifier here; the actual
 * surface (toast, modal, onboarding step) is a UI concern handled
 * separately and dismissed via a localStorage flag.
 */

/** Stable identifier consumed by i18n keys (`vendorHint.${id}.title` etc.). */
export type VendorEnergySaverId =
  | 'samsung'
  | 'huawei'
  | 'honor'
  | 'xiaomi'
  | 'oppo'
  | 'oneplus'
  | 'vivo'
  | 'realme';

export interface VendorEnergySaverHint {
  id: VendorEnergySaverId;
  /** Lowercased manufacturer string as reported by Build.MANUFACTURER */
  manufacturer: string;
}

/** Vendors with documented FCM-killing energy savers. Order doesn't matter
 *  because we match against an exact lowercased manufacturer string. */
const KNOWN_VENDORS: Record<string, VendorEnergySaverId> = {
  samsung: 'samsung',
  huawei: 'huawei',
  honor: 'honor',
  xiaomi: 'xiaomi',
  redmi: 'xiaomi',
  poco: 'xiaomi',
  oppo: 'oppo',
  oneplus: 'oneplus',
  vivo: 'vivo',
  realme: 'realme',
};

/**
 * Map a `Build.MANUFACTURER` string (whatever case the OEM ships) onto a
 * stable hint id. Returns null for devices we don't have specific guidance
 * for — the caller should suppress any vendor hint UI in that case.
 *
 * Pure function: no side effects, no native calls. Safe for unit tests.
 */
export function classifyVendor(manufacturer: string | null | undefined): VendorEnergySaverHint | null {
  if (!manufacturer) return null;
  const normalized = manufacturer.trim().toLowerCase();
  if (!normalized) return null;
  const id = KNOWN_VENDORS[normalized];
  if (!id) return null;
  return { id, manufacturer: normalized };
}

/** localStorage key for "user has already seen the hint for this vendor".
 *  Per-vendor so a user who migrates between OEMs (e.g. Samsung → Xiaomi)
 *  gets the new hint shown once on the new device. */
export const VENDOR_HINT_DISMISSED_KEY = 'forta_vendor_energy_hint_dismissed';

/** Returns true when the hint for [id] was previously dismissed. */
export function isVendorHintDismissed(id: VendorEnergySaverId): boolean {
  try {
    const raw = localStorage.getItem(VENDOR_HINT_DISMISSED_KEY);
    if (!raw) return false;
    const dismissed = JSON.parse(raw) as unknown;
    return Array.isArray(dismissed) && dismissed.includes(id);
  } catch {
    return false;
  }
}

/** Persist that the user has seen / dismissed the hint for [id]. */
export function markVendorHintDismissed(id: VendorEnergySaverId): void {
  try {
    // Recover from corrupt storage: if JSON.parse throws, treat as empty
    // and overwrite. Otherwise a single bad write (or external tamper)
    // would permanently lock the user out of dismissing the hint.
    let current: VendorEnergySaverId[] = [];
    const raw = localStorage.getItem(VENDOR_HINT_DISMISSED_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) current = parsed as VendorEnergySaverId[];
      } catch {
        /* corrupt — reset to empty */
      }
    }
    if (current.includes(id)) return;
    localStorage.setItem(VENDOR_HINT_DISMISSED_KEY, JSON.stringify([...current, id]));
  } catch {
    /* non-fatal: in degraded WebViews we'd just show the hint again next boot */
  }
}
