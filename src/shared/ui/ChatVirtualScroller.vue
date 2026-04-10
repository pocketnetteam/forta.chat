<script setup lang="ts" generic="T extends ChatVirtualItem">
/**
 * Inverted scroller for chat messages.
 *
 * Uses CSS `flex-direction: column-reverse` so that:
 *   - Data is passed as [newest, …, oldest]
 *   - item[0] renders at the visual BOTTOM (newest message)
 *   - scrollTop = 0  →  user sees newest messages
 *   - Appending older messages (history) = adding at the END of the array,
 *     which is the visual TOP — far from the viewport. Zero scroll correction.
 *
 * PAGINATION STRATEGY:
 * Dexie-level pagination is handled by chat-store:
 *   1. messageWindowSize starts at 50 (reset on room switch)
 *   2. useLiveQuery passes it as `limit` to MessageRepository.getMessages()
 *   3. getMessages() uses compound index [roomId+timestamp] with .limit()
 *      → physically reads only N newest records from IndexedDB
 *   4. On scroll-up, expandMessageWindow(25) bumps the limit
 *   5. useLiveQuery auto-reruns with new limit → more messages appear
 *
 * This means this component never receives more than ~200 items.
 * No progressive rendering or windowing needed here.
 *
 * PERF-02: ResizeObserver height cache eliminates synchronous reflow in checkAnchor.
 * PERF-02: will-change lifecycle promotes GPU layer only during active scroll.
 * D-02: scrollTop emission normalised via Math.abs for cross-WebView compatibility.
 */
import {
  ref,
  onMounted,
  onBeforeUnmount,
} from "vue";

// ───────────────── Props / Emits ─────────────────

export interface ChatVirtualItem {
  id: string;
  [key: string]: unknown;
}

const props = defineProps<{
  items: T[];
}>();

defineSlots<{
  default(props: { item: T; index: number }): any;
}>();

const emit = defineEmits<{
  (e: "scroll", scrollTop: number): void;
}>();

// ───────────────── Refs ─────────────────

const containerRef = ref<HTMLElement | null>(null);

// ───────────────── Height Cache (ResizeObserver) ─────────────────
const heightCache = new Map<string, number>();
let resizeObs: ResizeObserver | null = null;

// ───────────────── will-change lifecycle ─────────────────
const WILL_CHANGE_RELEASE_MS = 150;
let willChangeTimer: ReturnType<typeof setTimeout> | null = null;

// ───────────────── Scroll handling ─────────────────

const onScroll = () => {
  const el = containerRef.value;
  if (!el) return;

  // will-change lifecycle: promote layer on scroll start, release after idle
  if (!willChangeTimer) {
    el.style.willChange = "transform";
  }
  if (willChangeTimer !== null) clearTimeout(willChangeTimer);
  willChangeTimer = setTimeout(() => {
    willChangeTimer = null;
    if (containerRef.value) {
      containerRef.value.style.willChange = "auto";
    }
  }, WILL_CHANGE_RELEASE_MS);

  // Emit normalised scrollTop (D-02: Math.abs for cross-WebView compatibility)
  emit("scroll", Math.abs(el.scrollTop));
};

// ───────────────── Public API ─────────────────

const scrollToBottom = () => {
  if (containerRef.value) containerRef.value.scrollTop = 0;
};

const scrollToIndex = (index: number, opts?: { align?: "start" | "center" | "end" }) => {
  const el = containerRef.value;
  if (!el || index < 0 || index >= props.items.length) return;

  const itemEl = el.querySelector(`[data-virtual-id="${CSS.escape(props.items[index].id)}"]`) as HTMLElement | null;
  if (!itemEl) return;

  const containerRect = el.getBoundingClientRect();
  const itemRect = itemEl.getBoundingClientRect();
  const align = opts?.align ?? "center";

  const itemRelTop = itemRect.top - containerRect.top;
  const itemRelBottom = itemRect.bottom - containerRect.top;

  switch (align) {
    case "start":
      el.scrollTop += itemRelTop;
      break;
    case "center":
      el.scrollTop += itemRelTop - (containerRect.height - itemRect.height) / 2;
      break;
    case "end":
      el.scrollTop += itemRelBottom - containerRect.height;
      break;
  }
};

/** Check if user is near the bottom (newest messages). Works across WebView scrollTop sign conventions. */
const isNearBottom = (threshold = 50): boolean => {
  const el = containerRef.value;
  if (!el) return true;
  return Math.abs(el.scrollTop) <= threshold;
};

/** Expose container element as a getter so the parent always gets the raw HTMLElement. */
const getContainerEl = () => containerRef.value;
defineExpose({ scrollToBottom, scrollToIndex, getContainerEl, isNearBottom });

// ───────────────── New-message scroll anchoring ─────────────────
// When a new message arrives at index 0 (visual bottom) while the user
// is scrolled up, bump scrollTop by the new item's height so the viewport
// stays on the same content.

let prevFirstId: string | undefined;
let anchoringRaf: number | null = null;

const checkAnchor = () => {
  const el = containerRef.value;
  if (!el) return;
  const firstId = props.items[0]?.id;
  if (!prevFirstId || firstId === prevFirstId) {
    prevFirstId = firstId;
    return;
  }
  const st = el.scrollTop;
  // Chrome returns negative scrollTop for column-reverse
  if (Math.abs(st) > 50) {
    const oldIdx = props.items.findIndex((it) => it.id === prevFirstId);
    if (oldIdx > 0) {
      let addedHeight = 0;
      for (let i = 0; i < oldIdx; i++) {
        const id = props.items[i].id;
        // PERF-02: read from cache first, fall back to DOM query
        const cached = heightCache.get(id);
        if (cached !== undefined) {
          addedHeight += cached;
        } else {
          const itemEl = el.querySelector(
            `[data-virtual-id="${CSS.escape(id)}"]`
          ) as HTMLElement | null;
          addedHeight += itemEl?.offsetHeight ?? 80;
        }
      }
      el.scrollTop = st - addedHeight;
    }
  }
  prevFirstId = firstId;
};

// Use MutationObserver to detect when items change and check anchoring
let mutationObserver: MutationObserver | null = null;

onMounted(() => {
  const el = containerRef.value;
  if (!el) return;

  prevFirstId = props.items[0]?.id;

  // ResizeObserver height cache (Chrome 64+; graceful no-op on older WebViews)
  if (typeof ResizeObserver !== "undefined") {
    resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const vid = target.dataset.virtualId;
        if (vid) {
          const h = entry.borderBoxSize?.[0]?.blockSize ?? target.offsetHeight;
          heightCache.set(vid, h);
        }
      }
    });

    // Observe existing children
    el.querySelectorAll<HTMLElement>("[data-virtual-id]").forEach((child) => {
      resizeObs!.observe(child);
    });
  }

  mutationObserver = new MutationObserver((mutations) => {
    // Bridge: keep ResizeObserver in sync with DOM changes
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node instanceof HTMLElement && node.dataset.virtualId) {
          resizeObs?.observe(node);
        }
      }
      for (const node of mut.removedNodes) {
        if (node instanceof HTMLElement && node.dataset.virtualId) {
          resizeObs?.unobserve(node);
          heightCache.delete(node.dataset.virtualId);
        }
      }
    }

    // Existing anchoring logic — unchanged
    if (anchoringRaf !== null) return;
    anchoringRaf = requestAnimationFrame(() => {
      anchoringRaf = null;
      checkAnchor();
    });
  });
  mutationObserver.observe(el, { childList: true, subtree: false });
});

onBeforeUnmount(() => {
  mutationObserver?.disconnect();
  resizeObs?.disconnect();
  resizeObs = null;
  heightCache.clear();
  if (anchoringRaf !== null) cancelAnimationFrame(anchoringRaf);
  if (willChangeTimer !== null) {
    clearTimeout(willChangeTimer);
    willChangeTimer = null;
  }
});
</script>

<template>
  <div
    ref="containerRef"
    style="display: flex; flex-direction: column-reverse"
    class="overflow-y-auto overflow-x-hidden"
    @scroll.passive="onScroll"
  >
    <div
      v-for="(item, i) in items"
      :key="item.id"
      :data-virtual-id="item.id"
      style="flex-shrink: 0"
    >
      <slot :item="item" :index="i" />
    </div>
  </div>
</template>
