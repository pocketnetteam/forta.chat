import { type Ref } from "vue";

const VISIBILITY_THRESHOLD = 0.5;   // 50% of element visible
const BATCH_INTERVAL_MS = 2000;     // flush batch every 2 seconds

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

  function startTracking(container?: HTMLElement | null) {
    if (observer) return; // already tracking

    const root = container ?? containerRef.value;
    if (!root) {
      console.warn("[read-tracker] startTracking called without container");
      return;
    }

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
        threshold: [0, VISIBILITY_THRESHOLD],
      },
    );

    // Observe all elements that were registered before tracking started.
    // IntersectionObserver fires an initial callback for each observed element,
    // so elements already in viewport will be detected immediately.
    for (const el of pendingElements) {
      observer.observe(el);
    }
    pendingElements.clear();

    // Periodic flush of the high-water mark
    batchTimer = setInterval(flushBatch, BATCH_INTERVAL_MS);

    // First flush shortly after start to capture initial viewport
    setTimeout(flushBatch, 800);
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
    if (batchTimer !== null) {
      clearInterval(batchTimer);
      batchTimer = null;
    }
    flushBatch(); // send remaining reads
    pendingElements.clear();
    pendingHighestTs = 0;
    flushedHighestTs = 0;
  }

  return { startTracking, stopTracking, observeElement, unobserveElement };
}
