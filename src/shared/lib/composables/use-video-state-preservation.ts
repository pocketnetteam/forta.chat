import { onMounted, onScopeDispose, watch, type Ref } from "vue";

export interface PreservedVideoState {
  currentTime: number;
  paused: boolean;
  volume: number;
  muted: boolean;
}

/**
 * LRU-capped cache. The app is a messenger with potentially thousands of
 * video-containing messages; an unbounded Map would grow forever as the user
 * scrolls. 200 entries is ~8 KB and covers any realistic rotation/re-mount
 * window.
 */
const STATE_CACHE_CAP = 200;
const stateCache = new Map<string, PreservedVideoState>();

function cachePut(key: string, value: PreservedVideoState): void {
  if (stateCache.has(key)) stateCache.delete(key);
  stateCache.set(key, value);
  if (stateCache.size > STATE_CACHE_CAP) {
    const oldest = stateCache.keys().next().value;
    if (oldest !== undefined) stateCache.delete(oldest);
  }
}

/** Exported for test cleanup only. */
export function _resetVideoStateCache() {
  stateCache.clear();
}

/** Exported for tests. */
export function _getCacheSize() {
  return stateCache.size;
}

function sanitizeTime(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function sanitizeVolume(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

export interface UseVideoStatePreservationOptions {
  /** Periodically persist state while playing (ms). Set to 0 to disable. */
  saveIntervalMs?: number;
  /** Skip restoring paused=false (i.e. never auto-play on remount). */
  dontResumePlay?: boolean;
}

/**
 * Preserves video playback state across remounts keyed by `id`.
 * Android WebView can re-layout and virtual scrollers can recycle nodes on
 * rotation, which resets currentTime. Restoring the cached state on
 * `loadedmetadata` avoids the jarring reset.
 */
export function useVideoStatePreservation(
  videoRef: Ref<HTMLVideoElement | null>,
  id: Ref<string | null> | string,
  options: UseVideoStatePreservationOptions = {},
) {
  const { saveIntervalMs = 1000, dontResumePlay = false } = options;

  function currentId(): string | null {
    if (typeof id === "string") return id;
    return id.value;
  }

  function saveStateFrom(el: HTMLVideoElement | null) {
    const key = currentId();
    if (!el || !key) return;
    cachePut(key, {
      currentTime: sanitizeTime(el.currentTime),
      paused: el.paused,
      volume: sanitizeVolume(el.volume),
      muted: !!el.muted,
    });
  }

  function saveState() {
    saveStateFrom(videoRef.value);
  }

  function restoreState() {
    const el = videoRef.value;
    const key = currentId();
    if (!el || !key) return;
    const saved = stateCache.get(key);
    if (!saved) return;

    try {
      if (saved.currentTime > 0 && saved.currentTime < (el.duration || Infinity)) {
        el.currentTime = saved.currentTime;
      }
      if (Number.isFinite(saved.volume)) el.volume = saved.volume;
      el.muted = saved.muted;
      if (!saved.paused && !dontResumePlay) {
        void el.play().catch(() => {
          // Autoplay may be blocked; stay paused silently.
        });
      }
    } catch {
      // Safari can throw if element is not ready; ignore.
    }
  }

  function attachRestoreHandler(el: HTMLVideoElement) {
    if (el.readyState >= 1) {
      restoreState();
    } else {
      const handler = () => {
        el.removeEventListener("loadedmetadata", handler);
        restoreState();
      };
      el.addEventListener("loadedmetadata", handler);
    }
  }

  let saveTimer: ReturnType<typeof setInterval> | null = null;

  function startAutoSave() {
    if (saveIntervalMs <= 0 || saveTimer) return;
    saveTimer = setInterval(saveState, saveIntervalMs);
  }

  function stopAutoSave() {
    if (saveTimer) {
      clearInterval(saveTimer);
      saveTimer = null;
    }
  }

  onMounted(() => {
    const el = videoRef.value;
    if (el) attachRestoreHandler(el);
    startAutoSave();
  });

  watch(videoRef, (el, prev) => {
    // Save from the outgoing element explicitly — videoRef.value is already
    // the new element when this callback fires, so we can't use saveState().
    if (prev) saveStateFrom(prev);
    if (el) attachRestoreHandler(el);
  });

  onScopeDispose(() => {
    saveState();
    stopAutoSave();
  });

  return { saveState, restoreState };
}
