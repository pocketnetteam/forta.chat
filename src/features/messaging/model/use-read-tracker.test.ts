import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref } from "vue";
import { useReadTracker } from "./use-read-tracker";

function makeContainer(height = 400) {
  const el = document.createElement("div");
  // Mock getBoundingClientRect for the container
  el.getBoundingClientRect = () => ({
    top: 0, bottom: height, left: 0, right: 300,
    height, width: 300, x: 0, y: 0, toJSON: () => {},
  });
  // Mock scrollHeight so polling accepts the container
  Object.defineProperty(el, "scrollHeight", { value: height, configurable: true });
  return el;
}

function makeMessage(container: HTMLElement, ts: number, opts?: { top: number; height: number }) {
  const el = document.createElement("div");
  el.dataset.messageTs = String(ts);
  const top = opts?.top ?? 50;
  const h = opts?.height ?? 60;
  el.getBoundingClientRect = () => ({
    top, bottom: top + h, left: 0, right: 300,
    height: h, width: 300, x: 0, y: top, toJSON: () => {},
  });
  container.appendChild(el);
  return el;
}

// Stub IntersectionObserver — just track observed elements
let ioCallback: IntersectionObserverCallback;
const ioInstances: { root: Element | null; observed: Set<Element>; disconnect: () => void }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", class {
    observed = new Set<Element>();
    root: Element | null;
    constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
      ioCallback = cb;
      this.root = opts?.root as Element ?? null;
      ioInstances.push({ root: this.root, observed: this.observed, disconnect: () => {} });
    }
    observe(el: Element) { this.observed.add(el); }
    unobserve(el: Element) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
  });

  vi.stubGlobal("ResizeObserver", class {
    _cb: ResizeObserverCallback;
    _elements = new Set<Element>();
    constructor(cb: ResizeObserverCallback) { this._cb = cb; resizeObserverInstances.push(this); }
    observe(el: Element) { this._elements.add(el); }
    unobserve(el: Element) { this._elements.delete(el); }
    disconnect() { this._elements.clear(); }
    // Test helper: simulate a resize
    _trigger() { this._cb([], this); }
  });
});

const resizeObserverInstances: any[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  ioInstances.length = 0;
  resizeObserverInstances.length = 0;
});

describe("useReadTracker", () => {
  it("detects visible messages via manual scan on startTracking", () => {
    const container = makeContainer();
    const onBatchReady = vi.fn();
    const tracker = useReadTracker({
      containerRef: ref(container),
      getMessageTs: (el) => {
        const ts = el.dataset.messageTs;
        return ts ? parseInt(ts, 10) : null;
      },
      onBatchReady,
    });

    // Add messages before starting
    makeMessage(container, 1000, { top: 50, height: 60 });
    makeMessage(container, 2000, { top: 120, height: 60 });
    makeMessage(container, 3000, { top: 500, height: 60 }); // outside viewport (container height=400)

    tracker.startTracking(container);

    // Initial synchronous scan + flush should have detected messages at ts=1000, 2000
    expect(onBatchReady).toHaveBeenCalledWith(2000);
  });

  it("flushes on stopTracking", () => {
    const container = makeContainer();
    const onBatchReady = vi.fn();
    const tracker = useReadTracker({
      containerRef: ref(container),
      getMessageTs: (el) => {
        const ts = el.dataset.messageTs;
        return ts ? parseInt(ts, 10) : null;
      },
      onBatchReady,
    });

    makeMessage(container, 5000, { top: 100, height: 60 });
    tracker.startTracking(container);
    onBatchReady.mockClear();

    // Add a newer message that becomes visible
    makeMessage(container, 6000, { top: 200, height: 60 });
    tracker.performManualScan();
    // Not flushed yet (batch interval not elapsed)

    tracker.stopTracking();
    expect(onBatchReady).toHaveBeenCalledWith(6000);
  });

  it("re-scans on container resize (mobile keyboard/toolbar)", () => {
    const container = makeContainer();
    const onBatchReady = vi.fn();
    const tracker = useReadTracker({
      containerRef: ref(container),
      getMessageTs: (el) => {
        const ts = el.dataset.messageTs;
        return ts ? parseInt(ts, 10) : null;
      },
      onBatchReady,
    });

    // Message outside viewport initially
    makeMessage(container, 9000, { top: 500, height: 60 });
    tracker.startTracking(container);

    // Only ts=nothing detected (message at 500 is outside 400px container)
    onBatchReady.mockClear();

    // Simulate container resize (keyboard dismissed, viewport grows)
    container.getBoundingClientRect = () => ({
      top: 0, bottom: 600, left: 0, right: 300,
      height: 600, width: 300, x: 0, y: 0, toJSON: () => {},
    });

    // Trigger ResizeObserver
    const ro = resizeObserverInstances[0];
    expect(ro).toBeDefined();
    ro._trigger();

    // Debounce: 200ms
    vi.advanceTimersByTime(200);

    expect(onBatchReady).toHaveBeenCalledWith(9000);

    tracker.stopTracking();
  });

  it("observeElement before startTracking queues then bulk-observes", () => {
    const container = makeContainer();
    const onBatchReady = vi.fn();
    const tracker = useReadTracker({
      containerRef: ref(container),
      getMessageTs: (el) => {
        const ts = el.dataset.messageTs;
        return ts ? parseInt(ts, 10) : null;
      },
      onBatchReady,
    });

    const msg = makeMessage(container, 4000, { top: 100, height: 60 });
    tracker.observeElement(msg);

    tracker.startTracking(container);

    // The element should be observed by IntersectionObserver
    const io = ioInstances[0];
    expect(io.observed.has(msg)).toBe(true);

    tracker.stopTracking();
  });

  it("scroll fallback triggers debounced scan", () => {
    const container = makeContainer();
    const onBatchReady = vi.fn();
    const tracker = useReadTracker({
      containerRef: ref(container),
      getMessageTs: (el) => {
        const ts = el.dataset.messageTs;
        return ts ? parseInt(ts, 10) : null;
      },
      onBatchReady,
    });

    tracker.startTracking(container);
    // Flush all initial delayed scans (rAF + 500ms delayed scan)
    vi.advanceTimersByTime(600);
    onBatchReady.mockClear();

    // Add new message AFTER all initial scans completed
    makeMessage(container, 7777, { top: 200, height: 60 });

    // Simulate scroll event
    container.dispatchEvent(new Event("scroll"));

    // After scroll debounce (300ms) + batch flush interval (2s)
    vi.advanceTimersByTime(2500);

    expect(onBatchReady).toHaveBeenCalledWith(7777);

    tracker.stopTracking();
  });

  it("skips collapsed container (height=0)", () => {
    const container = makeContainer(0); // collapsed
    const onBatchReady = vi.fn();
    const tracker = useReadTracker({
      containerRef: ref(container),
      getMessageTs: (el) => {
        const ts = el.dataset.messageTs;
        return ts ? parseInt(ts, 10) : null;
      },
      onBatchReady,
    });

    makeMessage(container, 1000, { top: 0, height: 60 });
    tracker.startTracking(container);

    // Should not have detected anything (container collapsed)
    expect(onBatchReady).not.toHaveBeenCalled();

    tracker.stopTracking();
  });
});
