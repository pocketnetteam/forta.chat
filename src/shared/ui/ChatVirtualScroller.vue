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
 * All items are rendered (no windowing). messageWindowSize in the store
 * already limits the count to 50-200 items — well within DOM budget.
 */
import {
  ref,
  onMounted,
  onBeforeUnmount,
  nextTick,
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

// ───────────────── Scroll handling ─────────────────

const onScroll = () => {
  if (!containerRef.value) return;
  emit("scroll", containerRef.value.scrollTop);
};

// ───────────────── Public API ─────────────────

const scrollToBottom = () => {
  if (containerRef.value) containerRef.value.scrollTop = 0;
};

const scrollToIndex = (index: number, opts?: { align?: "start" | "center" | "end" }) => {
  const el = containerRef.value;
  if (!el || index < 0 || index >= props.items.length) return;

  // Find the DOM element for this item
  const itemEl = el.querySelector(`[data-virtual-id="${CSS.escape(props.items[index].id)}"]`) as HTMLElement | null;
  if (!itemEl) return;

  const containerRect = el.getBoundingClientRect();
  const itemRect = itemEl.getBoundingClientRect();
  const align = opts?.align ?? "center";

  // Calculate how much to scroll from current position
  // In column-reverse, items are laid out bottom-to-top
  const itemRelTop = itemRect.top - containerRect.top;
  const itemRelBottom = itemRect.bottom - containerRect.top;

  switch (align) {
    case "start":
      // Align item's top edge with viewport top
      el.scrollTop += itemRelTop;
      break;
    case "center":
      // Center the item in the viewport
      el.scrollTop += itemRelTop - (containerRect.height - itemRect.height) / 2;
      break;
    case "end":
      // Align item's bottom edge with viewport bottom
      el.scrollTop += itemRelBottom - containerRect.height;
      break;
  }
};

/** Expose container element as a getter so the parent always gets the raw HTMLElement. */
const getContainerEl = () => containerRef.value;
defineExpose({ scrollToBottom, scrollToIndex, getContainerEl });

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
    // Find how many new items were prepended at the bottom
    const oldIdx = props.items.findIndex((it) => it.id === prevFirstId);
    if (oldIdx > 0) {
      // Measure the actual height of new items
      let addedHeight = 0;
      for (let i = 0; i < oldIdx; i++) {
        const itemEl = el.querySelector(`[data-virtual-id="${CSS.escape(props.items[i].id)}"]`) as HTMLElement | null;
        addedHeight += itemEl?.offsetHeight ?? 80;
      }
      // Negative scrollTop: subtract height to move further from bottom
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

  mutationObserver = new MutationObserver(() => {
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
  if (anchoringRaf !== null) cancelAnimationFrame(anchoringRaf);
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
