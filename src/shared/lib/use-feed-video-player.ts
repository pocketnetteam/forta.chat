import { ref, onMounted, onBeforeUnmount, watch, type Ref } from "vue";
import {
  getVideoPosition,
  saveVideoPosition,
  clearVideoPosition,
} from "@/shared/lib/video-position-store";

export type FeedPlayerState = "idle" | "loading" | "ready" | "playing" | "paused" | "error";

export interface FeedPlayerOptions {
  /** Ref to the <video> element */
  videoRef: Ref<HTMLVideoElement | null>;
  /** Ref to the root container (for IntersectionObserver) */
  containerRef: Ref<HTMLElement | null>;
  /** Video URL (reactive — may arrive after decryption) */
  src: Ref<string | null>;
  /** Poster URL */
  poster?: string;
  /** Auto-play when visible (default false — tap-to-play for feed) */
  autoplay?: boolean;
  /** rootMargin for preload zone */
  preloadMargin?: string;
  /** Start muted (default true — feed convention). Pass false for post viewing. */
  startMuted?: boolean;
  /**
   * Stable key (e.g. the post video URL) to persist playback position under
   * (WEE-82 / forta-bugs#964). When set, the position is restored on load and
   * saved on pause/background/unmount so minimizing the app doesn't lose it.
   */
  persistKey?: string;
  /**
   * Called once all error retries are exhausted — the source is not going to
   * play. Lets the host switch to a different playback strategy (e.g. the
   * iframe embed fallback in VideoPlayer, WEE-82).
   */
  onFatalError?: () => void;
}

// ---------------------------------------------------------------------------
// Single Active Player — only one video plays at a time globally
// ---------------------------------------------------------------------------
let activePlayer: { pause: () => void } | null = null;

function claimActivePlayer(player: { pause: () => void }) {
  if (activePlayer && activePlayer !== player) {
    activePlayer.pause();
  }
  activePlayer = player;
}

function releaseActivePlayer(player: { pause: () => void }) {
  if (activePlayer === player) {
    activePlayer = null;
  }
}

/** Exported for test cleanup only. */
export function _resetActivePlayer() {
  activePlayer = null;
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 6000];
const IDLE_TIMEOUT = 10_000;

export function useFeedVideoPlayer(options: FeedPlayerOptions) {
  const {
    videoRef,
    containerRef,
    src,
    poster,
    autoplay = false,
    preloadMargin = "200px",
    startMuted = true,
    persistKey,
    onFatalError,
  } = options;

  const state = ref<FeedPlayerState>("idle");
  const currentTime = ref(0);
  const duration = ref(0);
  const buffered = ref(0);
  const isMuted = ref(startMuted);
  const errorCount = ref(0);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let visibilityObserver: IntersectionObserver | null = null;
  let preloadObserver: IntersectionObserver | null = null;
  let isInViewport = false;
  let playInProgress = false;

  const playerHandle = { pause };

  // --- Source management ---

  function attachSource() {
    const el = videoRef.value;
    const url = src.value;
    if (!el || !url) return;
    if (el.src === url && state.value !== "idle") return;

    el.preload = "metadata";
    el.src = url;
    el.load();
    state.value = "loading";
  }

  function detachSource() {
    const el = videoRef.value;
    if (!el) return;

    flushPosition();
    el.pause();
    el.removeAttribute("src");
    el.load();
    state.value = "idle";
    releaseActivePlayer(playerHandle);
    clearIdleTimer();
  }

  // --- Position persistence (WEE-82 / forta-bugs#964) ---

  /** Write the current position to the persistent store. */
  function flushPosition() {
    if (!persistKey) return;
    const el = videoRef.value;
    if (!el || state.value === "idle" || state.value === "error") return;
    saveVideoPosition(persistKey, el.currentTime, el.duration || 0);
  }

  // The WebView pauses media on background but never fires our pause() path,
  // so flush when the page hides — that's exactly the "minimize app" moment
  // the position must survive.
  function onVisibilityChange() {
    if (document.visibilityState === "hidden") flushPosition();
  }

  // --- Play / Pause ---

  async function play() {
    const el = videoRef.value;
    if (!el || !src.value || playInProgress) return;

    playInProgress = true;
    try {
      if (state.value === "idle") {
        attachSource();
        await new Promise<void>((resolve, reject) => {
          const onMeta = () => {
            el.removeEventListener("loadedmetadata", onMeta);
            el.removeEventListener("error", onErr);
            resolve();
          };
          const onErr = () => {
            el.removeEventListener("loadedmetadata", onMeta);
            el.removeEventListener("error", onErr);
            reject(new Error("Video load failed"));
          };
          el.addEventListener("loadedmetadata", onMeta);
          el.addEventListener("error", onErr);
        });
      }

      claimActivePlayer(playerHandle);
      clearIdleTimer();

      el.muted = isMuted.value;
      await el.play();
      state.value = "playing";
      errorCount.value = 0;
    } catch (err: unknown) {
      const e = err as Error;
      if (e.name !== "AbortError") {
        console.warn("[FeedPlayer] play failed:", e.name, e.message);
        state.value = "error";
        scheduleRetry();
      }
    } finally {
      playInProgress = false;
    }
  }

  function pause() {
    const el = videoRef.value;
    if (!el) return;

    el.pause();
    if (state.value === "playing") {
      state.value = "paused";
    }
    flushPosition();
    releaseActivePlayer(playerHandle);
    startIdleTimer();
  }

  function togglePlay() {
    if (state.value === "playing") {
      pause();
    } else {
      play();
    }
  }

  function toggleMute() {
    const el = videoRef.value;
    if (!el) return;
    isMuted.value = !isMuted.value;
    el.muted = isMuted.value;
  }

  function seek(time: number) {
    const el = videoRef.value;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(time, duration.value));
    currentTime.value = el.currentTime;
  }

  // --- Idle timer: release decoder after 10s of being paused ---

  function startIdleTimer() {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      if (state.value === "paused") {
        detachSource();
      }
    }, IDLE_TIMEOUT);
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // --- Error recovery ---

  function scheduleRetry() {
    if (errorCount.value >= MAX_RETRIES) {
      onFatalError?.();
      return;
    }

    const delay = RETRY_DELAYS[errorCount.value] ?? 6000;
    errorCount.value++;

    retryTimer = setTimeout(() => {
      detachSource();
      attachSource();
    }, delay);
  }

  // --- Video element event listeners ---

  function onLoadedMetadata() {
    const el = videoRef.value;
    if (!el) return;
    duration.value = el.duration;

    // Restore the saved position (WEE-82 / forta-bugs#964). The store already
    // drops near-start/near-end positions, so any non-zero value is resumable.
    if (persistKey) {
      const saved = getVideoPosition(persistKey);
      if (saved > 0 && saved < el.duration) {
        el.currentTime = saved;
        currentTime.value = saved;
      }
    }

    state.value = "ready";

    // Autoplay couldn't fire from the visibility observer: its initial
    // callback runs while the source is still loading (state !== "ready").
    // Once metadata lands, start playback if we're visible and asked to.
    if (autoplay && isInViewport && !playInProgress) {
      void play();
    }
  }

  function onTimeUpdate() {
    const el = videoRef.value;
    if (!el) return;
    currentTime.value = el.currentTime;
  }

  function onProgress() {
    const el = videoRef.value;
    if (!el || !el.buffered.length) return;
    buffered.value = el.buffered.end(el.buffered.length - 1);
  }

  function onEnded() {
    const el = videoRef.value;
    if (el) el.currentTime = 0;
    currentTime.value = 0;
    state.value = "paused";
    if (persistKey) clearVideoPosition(persistKey);
    releaseActivePlayer(playerHandle);
  }

  function onError() {
    if (state.value === "idle") return;
    state.value = "error";
    scheduleRetry();
  }

  // --- IntersectionObserver ---

  function setupObservers() {
    const container = containerRef.value;
    if (!container) return;

    preloadObserver = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && state.value === "idle" && src.value) {
          attachSource();
        }
      },
      { rootMargin: preloadMargin, threshold: 0 },
    );
    preloadObserver.observe(container);

    visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        isInViewport = entry.isIntersecting;
        if (!entry.isIntersecting && state.value === "playing") {
          pause();
        } else if (entry.isIntersecting && autoplay && state.value === "ready") {
          play();
        }
      },
      { threshold: 0.5 },
    );
    visibilityObserver.observe(container);
  }

  // --- Lifecycle ---

  function bindListeners() {
    const el = videoRef.value;
    if (!el) return;

    el.addEventListener("loadedmetadata", onLoadedMetadata);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("progress", onProgress);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);

    if (poster) el.poster = poster;
    el.playsInline = true;
  }

  function unbindListeners() {
    const el = videoRef.value;
    if (!el) return;

    el.removeEventListener("loadedmetadata", onLoadedMetadata);
    el.removeEventListener("timeupdate", onTimeUpdate);
    el.removeEventListener("progress", onProgress);
    el.removeEventListener("ended", onEnded);
    el.removeEventListener("error", onError);
  }

  onMounted(() => {
    bindListeners();
    setupObservers();
    if (persistKey) {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
  });

  watch(src, (newSrc) => {
    if (newSrc && state.value === "idle" && isInViewport) {
      attachSource();
    }
  });

  onBeforeUnmount(() => {
    if (persistKey) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    unbindListeners();
    detachSource();
    clearIdleTimer();
    if (retryTimer) clearTimeout(retryTimer);
    preloadObserver?.disconnect();
    visibilityObserver?.disconnect();
    releaseActivePlayer(playerHandle);
  });

  return {
    state,
    currentTime,
    duration,
    buffered,
    isMuted,
    play,
    pause,
    togglePlay,
    toggleMute,
    seek,
  };
}
