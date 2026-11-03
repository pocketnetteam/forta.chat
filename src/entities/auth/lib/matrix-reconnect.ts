import { isNative } from "@/shared/lib/platform";

/**
 * Retry a Matrix start that failed — typically an app launched without network. By then the chat
 * list has rendered from Dexie and the boot screen is gone, so nothing else calls `initMatrix()`
 * again. Retries follow events (network back, app back in the foreground), plus one scheduled
 * retry per failure that the caller asks for, spaced by `matrixRetryDelayMs`. A timer is needed
 * even while "online": with the homeserver unreachable behind a VPN, DNS or provider block,
 * `navigator.onLine` never changes, so no event ever fires (audit S2-01).
 */

const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 5 * 60_000;

/** Delay before the next scheduled retry after `failures` failed starts in a row:
 *  15 s, 30 s, 1 min, 2 min, 4 min, then every 5 min. */
export function matrixRetryDelayMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (n - 1));
}

export interface MatrixReconnectTriggers {
  /** Network transitions, as `onConnectivityChange` reports them. */
  onConnectivityChange: (listener: (change: { connected: boolean }) => void) => () => void;
  /** The app or page coming back to the foreground. */
  onForeground: (listener: () => void) => () => void;
}

export interface MatrixReconnectOptions {
  /** Whether a retry makes sense right now (signed in, not ready, no start in flight). */
  canRetry: () => boolean;
  retry: () => void;
  /** Also retry once after this many ms without waiting for a trigger. */
  retryAfterMs?: number;
}

/** Arms the triggers and returns the function that disarms them. */
export function armMatrixReconnect(
  triggers: MatrixReconnectTriggers,
  options: MatrixReconnectOptions,
): () => void {
  let armed = true;
  const attempt = (): void => {
    if (armed && options.canRetry()) options.retry();
  };
  const offNetwork = triggers.onConnectivityChange(({ connected }) => {
    if (connected) attempt();
  });
  const offForeground = triggers.onForeground(attempt);
  const timer = options.retryAfterMs === undefined ? null : setTimeout(attempt, options.retryAfterMs);
  return () => {
    armed = false;
    if (timer !== null) clearTimeout(timer);
    offNetwork();
    offForeground();
  };
}

/** Fires when the page turns visible and, on native, when the app becomes active: Android
 *  WebView does not report `visibilitychange` reliably, so both are wired, as elsewhere in the app. */
export function onForeground(listener: () => void): () => void {
  let removed = false;
  const onVisibility = (): void => {
    if (!removed && document.visibilityState === "visible") listener();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  let handle: { remove: () => Promise<void> } | null = null;
  if (isNative) {
    import("@capacitor/app")
      .then(({ App }) =>
        App.addListener("appStateChange", ({ isActive }) => {
          if (!removed && isActive) listener();
        }),
      )
      .then((h) => {
        if (removed) void h.remove().catch(() => { /* ignore */ });
        else handle = h;
      })
      .catch((e) => console.warn("[auth] appStateChange unavailable for the Matrix retry:", e));
  }

  return () => {
    removed = true;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    if (handle) {
      void handle.remove().catch(() => { /* ignore */ });
      handle = null;
    }
  };
}
