import { type Ref } from "vue";

const VISIBILITY_THRESHOLD = 0.3;        // lowered from 0.5 for mobile (dynamic toolbar clips viewport)
const BATCH_INTERVAL_MS = 2000;           // flush batch every 2 seconds
const SCROLL_SCAN_DEBOUNCE_MS = 300;      // fallback scan after scroll settles
const DELAYED_SCAN_MS = 500;              // extra scan for slow mobile layout

export interface ReadTrackerOptions {
  /** The scroll container element */
  containerRef: Ref<HTMLElement | null>;
  /** Extract message timestamp from a DOM element's data attributes.
   *  Returns null if the element is not a trackable message (e.g., own message). */
  getMessageTs: (el: HTMLElement) => number | null;
  /** Called with the highest read timestamp when a batch is ready */
  onBatchReady: (highestTs: number) => void;
}

export function useReadTracker(options: ReadTrackerOptions) {
  const { containerRef, getMessageTs, onBatchReady } = options;

  /** High-water mark: the highest timestamp seen so far (not yet flushed) */
  let pendingHighestTs = 0;
  /** High-water mark already sent to the store (avoid duplicate flushes) */
  let flushedHighestTs = 0;
  let batchTimer: ReturnType<typeof setInterval> | null = null;
  let observer: IntersectionObserver | null = null;
  /** Stored root element for use by performManualScan() */
  let trackedRoot: HTMLElement | null = null;
  /** Scroll-based fallback handler */
  let scrollHandler: (() => void) | null = null;
  let scrollScanTimer: ReturnType<typeof setTimeout> | null = null;
  let delayedScanTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Elements registered via observeElement() before startTracking() was called.
   * Once the observer is created, these are bulk-observed so IntersectionObserver
   * fires initial callbacks for elements already in the viewport.
   */
  const pendingElements = new Set<HTMLElement>();

  function promoteToRead(el: HTMLElement) {
    const ts = getMessageTs(el);
    if (ts !== null && ts > pendingHighestTs) {
      pendingHighestTs = ts;
    }
  }

  function flushBatch() {
    if (pendingHighestTs > flushedHighestTs) {
      const ts = pendingHighestTs;
      flushedHighestTs = ts;
      onBatchReady(ts);
    }
  }

  /**
   * Imperative scan: check all tracked elements via getBoundingClientRect.
   * This is the iOS Safari safety net — works regardless of IntersectionObserver
   * bugs with column-reverse containers.
   */
  function scanViewport() {
    if (!trackedRoot) return;
    const rootRect = trackedRoot.getBoundingClientRect();
    if (rootRect.height === 0) return; // collapsed container — skip
    const tracked = trackedRoot.querySelectorAll<HTMLElement>("[data-message-ts]");
    for (const el of tracked) {
      const elRect = el.getBoundingClientRect();
      // Element fully outside viewport — skip early
      if (elRect.bottom <= rootRect.top || elRect.top >= rootRect.bottom) continue;

      const visibleTop = Math.max(elRect.top, rootRect.top);
      const visibleBottom = Math.min(elRect.bottom, rootRect.bottom);
      const visibleHeight = visibleBottom - visibleTop;
      const ratio = elRect.height > 0 ? visibleHeight / elRect.height : 0;
      if (ratio >= VISIBILITY_THRESHOLD) {
        promoteToRead(el);
      }
    }
  }

  /** Scroll-based fallback: debounced scanViewport after each scroll event. */
  function onScrollFallback() {
    if (scrollScanTimer !== null) clearTimeout(scrollScanTimer);
    scrollScanTimer = setTimeout(() => {
      scrollScanTimer = null;
      scanViewport();
      // batch timer will flush — no need to flush here
    }, SCROLL_SCAN_DEBOUNCE_MS);
  }

  function startTracking(container?: HTMLElement | null): boolean {
    if (observer) return true; // already tracking

    const root = container ?? containerRef.value;
    if (!root) {
      console.warn("[read-tracker] startTracking called without container");
      return false;
    }

    trackedRoot = root;

    // ═══ PRIMARY: IntersectionObserver ═══
    // Multiple thresholds increase chances of callback firing on iOS Safari.
    // rootMargin adds 50px buffer for iOS dynamic toolbar / safe area.
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          // HWM: any message entering viewport immediately contributes its timestamp.
          // No dwell time needed — seeing a newer message marks all older ones as read.
          if (entry.isIntersecting && entry.intersectionRatio >= VISIBILITY_THRESHOLD) {
            promoteToRead(el);
          }
        }
      },
      {
        root,
        threshold: [0, 0.3, 0.5],
        rootMargin: "50px 0px 50px 0px",
      },
    );

    // Observe all elements that were registered before tracking started.
    // IntersectionObserver fires an initial callback for each observed element,
    // so elements already in viewport will be detected immediately.
    for (const el of pendingElements) {
      observer.observe(el);
    }
    pendingElements.clear();

    // ═══ FALLBACK: scroll event → debounced getBoundingClientRect scan ═══
    // Guarantees read detection even when IO is broken (iOS Safari + column-reverse).
    scrollHandler = onScrollFallback;
    root.addEventListener("scroll", scrollHandler, { passive: true });

    // Periodic flush of the high-water mark
    batchTimer = setInterval(flushBatch, BATCH_INTERVAL_MS);

    // Synchronous initial scan: catch elements already visible before
    // IntersectionObserver callbacks fire (belt-and-suspenders).
    scanViewport();
    flushBatch();

    // Deferred second scan: layout may not be fully settled yet, so re-check
    // after one animation frame for elements that became visible.
    requestAnimationFrame(() => {
      if (!observer) return; // stopped before rAF fired
      scanViewport();
      flushBatch();
    });

    // Delayed third scan: slow mobile devices may not settle layout within 1 frame.
    delayedScanTimer = setTimeout(() => {
      delayedScanTimer = null;
      if (!observer) return;
      scanViewport();
      flushBatch();
    }, DELAYED_SCAN_MS);

    return true;
  }

  /** Synchronous scan + flush — for callers that need to force re-checking. */
  function performManualScan() {
    scanViewport();
  }

  /** Immediately flush the current high-water mark to the store. */
  function flushNow() {
    flushBatch();
  }

  function observeElement(el: HTMLElement) {
    if (observer) {
      observer.observe(el);
    } else {
      // Observer not ready yet — queue for later
      pendingElements.add(el);
    }
  }

  function unobserveElement(el: HTMLElement) {
    if (observer) {
      observer.unobserve(el);
    }
    pendingElements.delete(el);
  }

  function stopTracking() {
    observer?.disconnect();
    observer = null;

    // Remove scroll fallback listener
    if (trackedRoot && scrollHandler) {
      trackedRoot.removeEventListener("scroll", scrollHandler);
    }
    scrollHandler = null;
    trackedRoot = null;

    if (scrollScanTimer !== null) {
      clearTimeout(scrollScanTimer);
      scrollScanTimer = null;
    }
    if (delayedScanTimer !== null) {
      clearTimeout(delayedScanTimer);
      delayedScanTimer = null;
    }
    if (batchTimer !== null) {
      clearInterval(batchTimer);
      batchTimer = null;
    }
    flushBatch(); // send remaining reads
    pendingElements.clear();
    pendingHighestTs = 0;
    flushedHighestTs = 0;
  }

  return { startTracking, stopTracking, observeElement, unobserveElement, performManualScan, flushNow };
}
