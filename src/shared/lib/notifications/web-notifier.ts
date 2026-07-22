/**
 * Web-side new message notifier — WEE-48 / forta-bugs#437, #439, #440, #445,
 * #498. Native Android already drives a real FCM push pipeline (WEE-11), but
 * Web/Electron users had NO audio cue and no banner when the tab was hidden;
 * five separate user reports flagged the missing "ping" as the single biggest
 * paper cut. This module fills that gap on the renderer side only — native
 * stays on its existing pipeline.
 *
 * Design:
 *   - Audio beep via WebAudio (no asset, works offline, decode-free).
 *   - Visible-tab + active-room gates so the user never hears their own
 *     conversation pinging at them.
 *   - Notification API: best-effort permission request, banner only when
 *     permission was already granted (we don't prompt on every message).
 *   - Throttled to one beep per ~1.5s so a burst of arrivals from a noisy
 *     room cannot turn into a buzzer.
 *   - Tab title unread badge is owned by useUnreadDocumentTitle (totalUnread),
 *     not by this module.
 */

const BEEP_THROTTLE_MS = 1500;
const BEEP_FREQ_HZ = 880;
const BEEP_DURATION_MS = 180;
const BEEP_GAIN = 0.04;

interface NotifyOptions {
  /** Stable id per chat room — used as Notification tag to dedup banner stacks */
  roomId: string;
  /** Plain-text body, already stripped of HTML / markdown */
  body: string;
  /** Banner title (falls back to `fallbackTitle` when omitted) */
  title?: string;
  /** Localised fallback title (e.g. app name) when `title` is absent */
  fallbackTitle: string;
}

let audioCtx: AudioContext | null = null;
let lastBeepAt = 0;

const isBrowser = (): boolean => typeof window !== "undefined" && typeof document !== "undefined";

const isTabVisible = (): boolean => {
  if (!isBrowser()) return true;
  return document.visibilityState === "visible" && document.hasFocus();
};

const ensureAudioContext = (): AudioContext | null => {
  if (!isBrowser()) return null;
  if (audioCtx) return audioCtx;
  type AudioContextCtor = typeof AudioContext;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
};

/** Short sine beep — no asset, decodes nothing. */
const playBeep = (): void => {
  const now = Date.now();
  if (now - lastBeepAt < BEEP_THROTTLE_MS) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;
  // Some browsers suspend the context until a user gesture. Resume best-effort.
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => { /* ignore — caller can't recover */ });
  }
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = BEEP_FREQ_HZ;
    osc.type = "sine";
    gain.gain.value = BEEP_GAIN;
    osc.connect(gain).connect(ctx.destination);
    const stopAt = ctx.currentTime + BEEP_DURATION_MS / 1000;
    osc.start();
    // Soft tail so the cutoff doesn't pop on Bluetooth speakers.
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    osc.stop(stopAt + 0.02);
    lastBeepAt = now;
  } catch {
    // Older WebAudio impls throw on reused contexts — silent fallback is fine.
  }
};

const fireBanner = (opts: NotifyOptions): void => {
  if (!isBrowser() || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const notification = new Notification(opts.title ?? opts.fallbackTitle, {
      body: opts.body,
      // `tag` collapses multiple banners from the same room into one,
      // so a noisy chat doesn't pile up in the OS notification center.
      tag: opts.roomId,
      silent: true, // beep is ours; OS sound would double up
    });
    notification.onclick = () => {
      try {
        notification.close();
        // Focus the window (Electron main + browser tab).
        window.focus();
        const api = (window as Window).electronAPI;
        api?.show?.();
        notificationClickHandler?.(opts.roomId);
      } catch {
        // Click handlers must never throw into the OS notification pipeline.
      }
    };
  } catch {
    // Notification ctor throws when called from a non-user-gesture in some
    // browsers; swallow — the beep still happened.
  }
};

type NotificationClickHandler = (roomId: string) => void;
let notificationClickHandler: NotificationClickHandler | null = null;

/**
 * Register a handler for OS notification banner clicks (open the room).
 * Returns an unsubscribe function.
 */
export const setNotificationClickHandler = (
  handler: NotificationClickHandler | null,
): (() => void) => {
  notificationClickHandler = handler;
  return () => {
    if (notificationClickHandler === handler) {
      notificationClickHandler = null;
    }
  };
};

/**
 * Public entry. Call once per genuinely-new inbound message that the user
 * has not yet seen. Idempotent at the throttle level — safe to fire from
 * any timeline-event handler.
 */
export const notifyNewMessage = (opts: NotifyOptions): void => {
  if (!isBrowser()) return;
  if (isTabVisible()) return; // active tab — user already sees the room
  playBeep();
  fireBanner(opts);
};

/**
 * Request Notification permission. Should be called from a user gesture
 * (e.g. settings toggle). Returns the final permission state.
 */
export const requestNotificationPermission = async (): Promise<NotificationPermission> => {
  if (!isBrowser() || !("Notification" in window)) return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
};

/** Test-only: reset module state between tests. */
export const __resetWebNotifierForTests = (): void => {
  audioCtx = null;
  lastBeepAt = 0;
  notificationClickHandler = null;
};
