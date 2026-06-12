import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, effectScope, type EffectScope } from "vue";
import { useFeedVideoPlayer, _resetActivePlayer } from "./use-feed-video-player";
import {
  getVideoPosition,
  saveVideoPosition,
  _resetVideoPositionCache,
} from "./video-position-store";

// ---------------------------------------------------------------------------
// Mock HTMLVideoElement with real event dispatching
// ---------------------------------------------------------------------------
function createMockVideoEl() {
  const listeners = new Map<string, Set<EventListener>>();

  const el = {
    src: "",
    preload: "",
    poster: "",
    muted: true,
    playsInline: false,
    currentTime: 0,
    duration: 0,
    buffered: { length: 0, end: vi.fn(() => 0) },
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn((attr: string) => {
      if (attr === "src") el.src = "";
    }),
    addEventListener: vi.fn((event: string, handler: EventListener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: EventListener) => {
      listeners.get(event)?.delete(handler);
    }),
    // Helper to fire events on the mock
    _emit(event: string) {
      listeners.get(event)?.forEach((handler) => handler(new Event(event)));
    },
  };
  return el as unknown as HTMLVideoElement & { _emit: (event: string) => void };
}

// ---------------------------------------------------------------------------
// Mock IntersectionObserver
// ---------------------------------------------------------------------------
type IOCallback = (entries: IntersectionObserverEntry[]) => void;

let ioInstances: Array<{
  callback: IOCallback;
  options: IntersectionObserverInit;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];

class MockIntersectionObserver {
  callback: IOCallback;
  options: IntersectionObserverInit;
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();

  constructor(callback: IOCallback, options: IntersectionObserverInit = {}) {
    this.callback = callback;
    this.options = options;
    ioInstances.push({ callback, options, disconnect: this.disconnect });
  }
}

function getPreloadObserver() {
  return ioInstances.find((io) => io.options.rootMargin === "200px");
}

function getVisibilityObserver() {
  return ioInstances.find((io) => io.options.threshold === 0.5);
}

function triggerIO(io: typeof ioInstances[0] | undefined, isIntersecting: boolean) {
  io?.callback([{ isIntersecting } as IntersectionObserverEntry]);
}

// ---------------------------------------------------------------------------
// Mock lifecycle hooks
// ---------------------------------------------------------------------------
const mountedCallbacks: Array<() => void> = [];
const unmountCallbacks: Array<() => void> = [];

vi.mock("vue", async () => {
  const actual = await vi.importActual<typeof import("vue")>("vue");
  return {
    ...actual,
    onMounted: (cb: () => void) => mountedCallbacks.push(cb),
    onBeforeUnmount: (cb: () => void) => unmountCallbacks.push(cb),
  };
});

function simulateMount() {
  mountedCallbacks.forEach((cb) => cb());
}

function simulateUnmount() {
  unmountCallbacks.forEach((cb) => cb());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("useFeedVideoPlayer", () => {
  let videoEl: ReturnType<typeof createMockVideoEl>;
  let containerEl: HTMLElement;
  let scopes: EffectScope[];

  beforeEach(() => {
    vi.useFakeTimers();
    ioInstances = [];
    mountedCallbacks.length = 0;
    unmountCallbacks.length = 0;
    scopes = [];

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    videoEl = createMockVideoEl();
    containerEl = document.createElement("div");
  });

  afterEach(() => {
    scopes.forEach((s) => s.stop());
    _resetActivePlayer();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup(
    overrides: {
      src?: string | null;
      autoplay?: boolean;
      persistKey?: string;
      onFatalError?: () => void;
    } = {},
  ) {
    const scope = effectScope();
    scopes.push(scope);

    const videoRef = ref<HTMLVideoElement | null>(videoEl as unknown as HTMLVideoElement);
    const containerRef = ref<HTMLElement | null>(containerEl);
    const srcRef = ref<string | null>("src" in overrides ? overrides.src! : "https://example.com/video.mp4");

    const result = scope.run(() =>
      useFeedVideoPlayer({
        videoRef,
        containerRef,
        src: srcRef,
        autoplay: overrides.autoplay ?? false,
        persistKey: overrides.persistKey,
        onFatalError: overrides.onFatalError,
      }),
    )!;

    simulateMount();
    return { ...result, srcRef };
  }

  async function playAndReady(
    player: ReturnType<typeof setup>,
    el: ReturnType<typeof createMockVideoEl>,
  ) {
    const playPromise = player.play();
    // play() waits for loadedmetadata when idle → fire it
    Object.defineProperty(el, "duration", { value: 60, writable: true });
    el._emit("loadedmetadata");
    await playPromise;
  }

  it("starts in idle state", () => {
    const { state } = setup();
    expect(state.value).toBe("idle");
  });

  it("creates two IntersectionObservers on mount", () => {
    setup();
    expect(ioInstances).toHaveLength(2);
    expect(getPreloadObserver()).toBeDefined();
    expect(getVisibilityObserver()).toBeDefined();
  });

  it("attaches source when preload observer fires", () => {
    setup();
    triggerIO(getPreloadObserver(), true);
    expect(videoEl.src).toBe("https://example.com/video.mp4");
    expect(videoEl.preload).toBe("metadata");
  });

  it("does not attach source when preload observer fires but src is null", () => {
    const { state } = setup({ src: null });
    triggerIO(getPreloadObserver(), true);
    // Should remain idle — attachSource skips when src is null
    expect(state.value).toBe("idle");
  });

  it("plays on togglePlay and transitions to playing", async () => {
    const player = setup();

    await playAndReady(player, videoEl);

    expect(videoEl.play).toHaveBeenCalled();
    expect(player.state.value).toBe("playing");
  });

  it("pauses on togglePlay when playing", async () => {
    const player = setup();

    await playAndReady(player, videoEl);
    expect(player.state.value).toBe("playing");

    player.togglePlay();
    expect(videoEl.pause).toHaveBeenCalled();
    expect(player.state.value).toBe("paused");
  });

  it("toggles mute state", () => {
    const { isMuted, toggleMute } = setup();
    expect(isMuted.value).toBe(true);

    toggleMute();
    expect(isMuted.value).toBe(false);
    expect(videoEl.muted).toBe(false);

    toggleMute();
    expect(isMuted.value).toBe(true);
    expect(videoEl.muted).toBe(true);
  });

  it("pauses when visibility observer reports leaving viewport while playing", async () => {
    const player = setup();

    await playAndReady(player, videoEl);
    expect(player.state.value).toBe("playing");

    triggerIO(getVisibilityObserver(), false);
    expect(videoEl.pause).toHaveBeenCalled();
    expect(player.state.value).toBe("paused");
  });

  it("detaches source after idle timeout (10s) when paused", async () => {
    const player = setup();

    await playAndReady(player, videoEl);

    player.togglePlay();
    expect(player.state.value).toBe("paused");

    vi.advanceTimersByTime(10_000);
    expect(videoEl.removeAttribute).toHaveBeenCalledWith("src");
    expect(player.state.value).toBe("idle");
  });

  it("disconnects observers on unmount", () => {
    setup();
    simulateUnmount();

    ioInstances.forEach((io) => {
      expect(io.disconnect).toHaveBeenCalled();
    });
  });

  it("detaches source on unmount", () => {
    setup();
    triggerIO(getPreloadObserver(), true);
    simulateUnmount();
    expect(videoEl.removeAttribute).toHaveBeenCalledWith("src");
  });

  describe("single active player policy", () => {
    it("pauses first player when second player starts", async () => {
      // Player 1
      const scope1 = effectScope();
      scopes.push(scope1);
      const videoEl1 = createMockVideoEl();
      const containerEl1 = document.createElement("div");
      const player1 = scope1.run(() =>
        useFeedVideoPlayer({
          videoRef: ref<HTMLVideoElement | null>(videoEl1 as unknown as HTMLVideoElement),
          containerRef: ref<HTMLElement | null>(containerEl1),
          src: ref("https://example.com/video1.mp4"),
        }),
      )!;
      simulateMount();

      await playAndReady({ ...player1 } as ReturnType<typeof setup>, videoEl1);
      expect(player1.state.value).toBe("playing");

      // Player 2
      mountedCallbacks.length = 0;
      const scope2 = effectScope();
      scopes.push(scope2);
      const videoEl2 = createMockVideoEl();
      const containerEl2 = document.createElement("div");
      const player2 = scope2.run(() =>
        useFeedVideoPlayer({
          videoRef: ref<HTMLVideoElement | null>(videoEl2 as unknown as HTMLVideoElement),
          containerRef: ref<HTMLElement | null>(containerEl2),
          src: ref("https://example.com/video2.mp4"),
        }),
      )!;
      simulateMount();

      await playAndReady({ ...player2 } as ReturnType<typeof setup>, videoEl2);

      // Player 1 should have been paused
      expect(videoEl1.pause).toHaveBeenCalled();
      expect(player2.state.value).toBe("playing");
    });
  });

  describe("autoplay", () => {
    it("auto-plays when visible and autoplay is true", () => {
      const { state } = setup({ autoplay: true });

      triggerIO(getPreloadObserver(), true);

      // Fire loadedmetadata → state becomes "ready"
      Object.defineProperty(videoEl, "duration", { value: 30, writable: true });
      videoEl._emit("loadedmetadata");
      expect(state.value).toBe("ready");

      // Visibility → should auto-play
      triggerIO(getVisibilityObserver(), true);
      expect(videoEl.play).toHaveBeenCalled();
    });

    it("auto-plays when metadata arrives AFTER visibility fired (WEE-82/#963)", () => {
      // Modal flow: the player becomes visible while the source is still
      // loading. The visibility callback can't start playback (not ready yet)
      // — loadedmetadata must pick it up, otherwise autoplay never happens.
      setup({ autoplay: true });

      triggerIO(getVisibilityObserver(), true); // visible, but still idle/loading
      triggerIO(getPreloadObserver(), true); // attach source → loading

      expect(videoEl.play).not.toHaveBeenCalled();

      Object.defineProperty(videoEl, "duration", { value: 30, writable: true });
      videoEl._emit("loadedmetadata");

      expect(videoEl.play).toHaveBeenCalled();
    });
  });

  describe("position persistence (WEE-82 / forta-bugs#964)", () => {
    const PERSIST_KEY = "peertube://host/uuid";

    beforeEach(() => {
      localStorage.clear();
      _resetVideoPositionCache();
    });

    it("restores the saved position when metadata loads", () => {
      saveVideoPosition(PERSIST_KEY, 120, 600);

      setup({ persistKey: PERSIST_KEY });
      triggerIO(getPreloadObserver(), true);

      Object.defineProperty(videoEl, "duration", { value: 600, writable: true });
      videoEl._emit("loadedmetadata");

      expect(videoEl.currentTime).toBe(120);
    });

    it("does not touch currentTime when nothing is saved", () => {
      setup({ persistKey: PERSIST_KEY });
      triggerIO(getPreloadObserver(), true);

      Object.defineProperty(videoEl, "duration", { value: 600, writable: true });
      videoEl._emit("loadedmetadata");

      expect(videoEl.currentTime).toBe(0);
    });

    it("saves the position on pause", async () => {
      const player = setup({ persistKey: PERSIST_KEY });

      const playPromise = player.play();
      Object.defineProperty(videoEl, "duration", { value: 600, writable: true });
      videoEl._emit("loadedmetadata");
      await playPromise;

      videoEl.currentTime = 240;
      player.pause();

      expect(getVideoPosition(PERSIST_KEY)).toBe(240);
    });

    it("flushes the position when the page is hidden (app minimized)", async () => {
      const player = setup({ persistKey: PERSIST_KEY });

      const playPromise = player.play();
      Object.defineProperty(videoEl, "duration", { value: 600, writable: true });
      videoEl._emit("loadedmetadata");
      await playPromise;

      videoEl.currentTime = 333;
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));

      expect(getVideoPosition(PERSIST_KEY)).toBe(333);

      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
    });

    it("saves the position when the player unmounts", async () => {
      const player = setup({ persistKey: PERSIST_KEY });

      const playPromise = player.play();
      Object.defineProperty(videoEl, "duration", { value: 600, writable: true });
      videoEl._emit("loadedmetadata");
      await playPromise;

      videoEl.currentTime = 90;
      simulateUnmount();

      expect(getVideoPosition(PERSIST_KEY)).toBe(90);
    });

    it("clears the saved position when the video ends", async () => {
      saveVideoPosition(PERSIST_KEY, 120, 600);
      const player = setup({ persistKey: PERSIST_KEY });

      const playPromise = player.play();
      Object.defineProperty(videoEl, "duration", { value: 600, writable: true });
      videoEl._emit("loadedmetadata");
      await playPromise;

      videoEl._emit("ended");

      expect(getVideoPosition(PERSIST_KEY)).toBe(0);
    });

    it("does not persist anything without a persistKey", async () => {
      const player = setup();

      const playPromise = player.play();
      Object.defineProperty(videoEl, "duration", { value: 600, writable: true });
      videoEl._emit("loadedmetadata");
      await playPromise;

      videoEl.currentTime = 240;
      player.pause();

      expect(localStorage.getItem("forta-video-positions")).toBeNull();
    });
  });

  describe("error recovery", () => {
    it("calls onFatalError once retries are exhausted (WEE-82 iframe fallback)", async () => {
      const onFatalError = vi.fn();
      const player = setup({ onFatalError });

      await playAndReady(player, videoEl);

      // 3 retries with backoff (1s, 3s, 6s), each failing again
      for (const delay of [1000, 3000, 6000]) {
        videoEl._emit("error");
        expect(onFatalError).not.toHaveBeenCalled();
        vi.advanceTimersByTime(delay);
      }

      // 4th error → retry budget gone → fatal
      videoEl._emit("error");
      expect(onFatalError).toHaveBeenCalledTimes(1);
    });

    it("retries on error with backoff", async () => {
      const player = setup();

      await playAndReady(player, videoEl);

      // Trigger error
      videoEl._emit("error");
      expect(player.state.value).toBe("error");

      // After 1s — first retry
      vi.advanceTimersByTime(1000);
      expect(videoEl.removeAttribute).toHaveBeenCalledWith("src");
      expect(videoEl.load).toHaveBeenCalled();
    });

    it("play() rejects when video fails to load (no infinite hang)", async () => {
      const player = setup();

      const playPromise = player.play();
      // Fire error instead of loadedmetadata
      videoEl._emit("error");
      await playPromise;

      expect(player.state.value).toBe("error");
    });
  });

  describe("seek", () => {
    it("clamps seek within duration bounds", async () => {
      const player = setup();

      await playAndReady(player, videoEl);

      player.seek(30);
      expect(videoEl.currentTime).toBe(30);

      // Should clamp to 0
      player.seek(-10);
      expect(videoEl.currentTime).toBe(0);
    });
  });
});
