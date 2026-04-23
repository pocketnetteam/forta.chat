import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, effectScope, nextTick } from "vue";
import {
  useVideoStatePreservation,
  _resetVideoStateCache,
  _getCacheSize,
} from "./use-video-state-preservation";

// ---------------------------------------------------------------------------
// Mock HTMLVideoElement with real event dispatching
// ---------------------------------------------------------------------------
function createMockVideoEl(overrides: Partial<HTMLVideoElement> = {}) {
  const listeners = new Map<string, Set<EventListener>>();

  const el = {
    readyState: 0,
    currentTime: 0,
    duration: 100,
    paused: true,
    volume: 1,
    muted: false,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    addEventListener: vi.fn((event: string, handler: EventListener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: EventListener) => {
      listeners.get(event)?.delete(handler);
    }),
    _emit(event: string) {
      listeners.get(event)?.forEach((handler) => handler(new Event(event)));
    },
    ...overrides,
  };
  return el as unknown as HTMLVideoElement & {
    _emit: (event: string) => void;
    play: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// Mock lifecycle hooks — collect callbacks, fire manually in tests
// ---------------------------------------------------------------------------
const mountedCallbacks: Array<() => void> = [];
const disposeCallbacks: Array<() => void> = [];

vi.mock("vue", async () => {
  const actual = await vi.importActual<typeof import("vue")>("vue");
  return {
    ...actual,
    onMounted: (cb: () => void) => mountedCallbacks.push(cb),
    onScopeDispose: (cb: () => void) => disposeCallbacks.push(cb),
  };
});

function simulateMount() {
  mountedCallbacks.forEach((cb) => cb());
}

function simulateUnmount() {
  disposeCallbacks.forEach((cb) => cb());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("useVideoStatePreservation", () => {
  beforeEach(() => {
    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;
    _resetVideoStateCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.runOnlyPendingTimers();
    }
    vi.useRealTimers();
  });

  it("saves currentTime on unmount", () => {
    const el = createMockVideoEl({ currentTime: 42, paused: false });
    const videoRef = ref<HTMLVideoElement | null>(el);

    useVideoStatePreservation(videoRef, "msg-1");
    simulateMount();
    simulateUnmount();

    // Re-mount a fresh element, should restore currentTime=42
    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;

    const el2 = createMockVideoEl({ readyState: 1, duration: 100 });
    const videoRef2 = ref<HTMLVideoElement | null>(el2);

    useVideoStatePreservation(videoRef2, "msg-1");
    simulateMount();

    expect(el2.currentTime).toBe(42);
  });

  it("restores paused state and triggers play when previously playing", async () => {
    const el = createMockVideoEl({ currentTime: 10, paused: false });
    const videoRef = ref<HTMLVideoElement | null>(el);

    useVideoStatePreservation(videoRef, "msg-play");
    simulateMount();
    simulateUnmount();

    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;
    const el2 = createMockVideoEl({ readyState: 1, duration: 100 });
    const videoRef2 = ref<HTMLVideoElement | null>(el2);

    useVideoStatePreservation(videoRef2, "msg-play");
    simulateMount();

    expect(el2.play).toHaveBeenCalledTimes(1);
  });

  it("does not call play if previously paused", () => {
    const el = createMockVideoEl({ currentTime: 15, paused: true });
    const videoRef = ref<HTMLVideoElement | null>(el);

    useVideoStatePreservation(videoRef, "msg-paused");
    simulateMount();
    simulateUnmount();

    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;
    const el2 = createMockVideoEl({ readyState: 1, duration: 100 });
    const videoRef2 = ref<HTMLVideoElement | null>(el2);

    useVideoStatePreservation(videoRef2, "msg-paused");
    simulateMount();

    expect(el2.play).not.toHaveBeenCalled();
    expect(el2.currentTime).toBe(15);
  });

  it("waits for loadedmetadata if readyState is 0", () => {
    const el = createMockVideoEl({ currentTime: 30 });
    const videoRef = ref<HTMLVideoElement | null>(el);
    useVideoStatePreservation(videoRef, "msg-loading");
    simulateMount();
    simulateUnmount();

    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;
    const el2 = createMockVideoEl({ readyState: 0, duration: 100 });
    const videoRef2 = ref<HTMLVideoElement | null>(el2);

    useVideoStatePreservation(videoRef2, "msg-loading");
    simulateMount();

    // Before metadata, currentTime remains at default
    expect(el2.currentTime).toBe(0);

    // After metadata loads, state should restore
    el2._emit("loadedmetadata");
    expect(el2.currentTime).toBe(30);
  });

  it("preserves volume and muted state", () => {
    const el = createMockVideoEl({ currentTime: 5, volume: 0.3, muted: true });
    const videoRef = ref<HTMLVideoElement | null>(el);
    useVideoStatePreservation(videoRef, "msg-audio");
    simulateMount();
    simulateUnmount();

    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;
    const el2 = createMockVideoEl({ readyState: 1, duration: 100 });
    const videoRef2 = ref<HTMLVideoElement | null>(el2);
    useVideoStatePreservation(videoRef2, "msg-audio");
    simulateMount();

    expect(el2.volume).toBe(0.3);
    expect(el2.muted).toBe(true);
  });

  it("does not restore for a different id", () => {
    const el = createMockVideoEl({ currentTime: 50, paused: true });
    const videoRef = ref<HTMLVideoElement | null>(el);
    useVideoStatePreservation(videoRef, "msg-A");
    simulateMount();
    simulateUnmount();

    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;
    const el2 = createMockVideoEl({ readyState: 1, duration: 100 });
    const videoRef2 = ref<HTMLVideoElement | null>(el2);
    useVideoStatePreservation(videoRef2, "msg-B");
    simulateMount();

    expect(el2.currentTime).toBe(0);
  });

  it("guards against NaN and out-of-range currentTime", () => {
    const el = createMockVideoEl({ currentTime: NaN, paused: true });
    const videoRef = ref<HTMLVideoElement | null>(el);
    useVideoStatePreservation(videoRef, "msg-nan");
    simulateMount();
    simulateUnmount();

    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;
    const el2 = createMockVideoEl({ readyState: 1, duration: 100 });
    const videoRef2 = ref<HTMLVideoElement | null>(el2);
    useVideoStatePreservation(videoRef2, "msg-nan");
    simulateMount();

    // NaN sanitized to 0 — no harmful write
    expect(el2.currentTime).toBe(0);
  });

  it("auto-saves periodically while playing (saveInterval>0)", () => {
    const el = createMockVideoEl({ currentTime: 0, paused: false });
    const videoRef = ref<HTMLVideoElement | null>(el);

    useVideoStatePreservation(videoRef, "msg-auto", { saveIntervalMs: 1000 });
    simulateMount();

    // Advance currentTime then fire timer
    el.currentTime = 10;
    vi.advanceTimersByTime(1000);

    simulateUnmount();

    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;
    const el2 = createMockVideoEl({ readyState: 1, duration: 100 });
    const videoRef2 = ref<HTMLVideoElement | null>(el2);
    useVideoStatePreservation(videoRef2, "msg-auto");
    simulateMount();

    expect(el2.currentTime).toBe(10);
  });

  it("caps cache size to prevent unbounded growth in long sessions", () => {
    // Saturate cache with >200 entries; oldest should be evicted.
    for (let i = 0; i < 250; i++) {
      const el = createMockVideoEl({ currentTime: i, paused: true });
      const videoRef = ref<HTMLVideoElement | null>(el);
      useVideoStatePreservation(videoRef, `msg-${i}`);
      simulateMount();
      simulateUnmount();
      mountedCallbacks.length = 0;
      disposeCallbacks.length = 0;
    }
    expect(_getCacheSize()).toBeLessThanOrEqual(200);

    // The oldest entry (msg-0) should have been evicted.
    const freshEl = createMockVideoEl({ readyState: 1, duration: 1000 });
    const freshRef = ref<HTMLVideoElement | null>(freshEl);
    useVideoStatePreservation(freshRef, "msg-0");
    simulateMount();
    expect(freshEl.currentTime).toBe(0); // evicted → not restored

    // A recent entry (msg-249) should still be restorable.
    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;
    const recentEl = createMockVideoEl({ readyState: 1, duration: 1000 });
    const recentRef = ref<HTMLVideoElement | null>(recentEl);
    useVideoStatePreservation(recentRef, "msg-249");
    simulateMount();
    expect(recentEl.currentTime).toBe(249); // still in cache
  });

  it("saves on swap when videoRef changes mid-lifecycle", async () => {
    // Use real fake timers to unblock nextTick scheduling
    vi.useRealTimers();

    const firstEl = createMockVideoEl({ currentTime: 12, paused: true });
    const videoRef = ref<HTMLVideoElement | null>(firstEl);

    const scope = effectScope();
    scope.run(() => useVideoStatePreservation(videoRef, "msg-swap"));
    simulateMount();

    // Swap to a different element (e.g., user navigates to next media).
    const secondEl = createMockVideoEl({ readyState: 1, duration: 100 });
    videoRef.value = secondEl as unknown as HTMLVideoElement;

    // watch(videoRef) has flush 'pre' by default; await nextTick to flush.
    await nextTick();

    // Second element should restore previous state.
    expect(secondEl.currentTime).toBe(12);

    scope.stop();
  });

  it("skips resume play when dontResumePlay is set", () => {
    const el = createMockVideoEl({ currentTime: 5, paused: false });
    const videoRef = ref<HTMLVideoElement | null>(el);
    useVideoStatePreservation(videoRef, "msg-no-resume", { dontResumePlay: true });
    simulateMount();
    simulateUnmount();

    mountedCallbacks.length = 0;
    disposeCallbacks.length = 0;
    const el2 = createMockVideoEl({ readyState: 1, duration: 100 });
    const videoRef2 = ref<HTMLVideoElement | null>(el2);
    useVideoStatePreservation(videoRef2, "msg-no-resume", { dontResumePlay: true });
    simulateMount();

    expect(el2.play).not.toHaveBeenCalled();
    expect(el2.currentTime).toBe(5);
  });
});
