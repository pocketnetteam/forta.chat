import { type Ref } from "vue";

const VISIBILITY_THRESHOLD = 0.5;   // 50% of element visible
const DWELL_TIME_MS = 500;          // must stay visible for 500ms
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

  // messageId → timestamp when it became visible
  const visibleSince = new Map<string, number>();
  let pendingHighestTs = 0;
  let batchTimer: ReturnType<typeof setInterval> | null = null;
  let observer: IntersectionObserver | null = null;

  function promoteToRead(el: HTMLElement) {
    const ts = getMessageTs(el);
    if (ts !== null && ts > pendingHighestTs) {
      pendingHighestTs = ts;
    }
  }

  function flushBatch() {
    if (pendingHighestTs > 0) {
      const ts = pendingHighestTs;
      pendingHighestTs = 0;
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
        const now = Date.now();

        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const msgId = el.dataset.messageId;
          if (!msgId) continue;

          if (entry.isIntersecting && entry.intersectionRatio >= VISIBILITY_THRESHOLD) {
            // Entered viewport — start dwell timer
            if (!visibleSince.has(msgId)) {
              visibleSince.set(msgId, now);
            }
          } else {
            // Left viewport — check if dwelled long enough
            const since = visibleSince.get(msgId);
            if (since !== undefined && (now - since) >= DWELL_TIME_MS) {
              promoteToRead(el);
            }
            visibleSince.delete(msgId);
          }
        }
      },
      {
        root,
        threshold: [0, VISIBILITY_THRESHOLD],
      },
    );

    // Batch timer: check dwelling messages + flush
    batchTimer = setInterval(() => {
      const now = Date.now();

      for (const [msgId, since] of visibleSince) {
        if (now - since >= DWELL_TIME_MS) {
          const el = root.querySelector(`[data-message-id="${CSS.escape(msgId)}"]`) as HTMLElement | null;
          if (el) promoteToRead(el);
          visibleSince.delete(msgId);
        }
      }

      flushBatch();
    }, BATCH_INTERVAL_MS);
  }

  function observeElement(el: HTMLElement) {
    observer?.observe(el);
  }

  function unobserveElement(el: HTMLElement) {
    observer?.unobserve(el);
    const msgId = el.dataset.messageId;
    if (msgId) visibleSince.delete(msgId);
  }

  function stopTracking() {
    observer?.disconnect();
    observer = null;
    if (batchTimer !== null) {
      clearInterval(batchTimer);
      batchTimer = null;
    }
    flushBatch(); // send remaining reads
    visibleSince.clear();
  }

  return { startTracking, stopTracking, observeElement, unobserveElement };
}
