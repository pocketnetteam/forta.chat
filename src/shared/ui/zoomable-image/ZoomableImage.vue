<script setup lang="ts">
/**
 * Standalone zoom/pan/double-tap/swipe-down photo viewer.
 *
 * Distilled from the MediaViewer used in chat — same touch gestures,
 * same pinch-zoom math (`touchDistance` + `nextScale` from
 * `features/messaging/model/pinch-zoom.ts`), but without the chat-store
 * coupling so it can be reused anywhere that has a single blob URL to
 * show fullscreen (Storage cache preview, future moderation tools).
 *
 * - One-finger drag while zoomed in → pan
 * - One-finger swipe down at 1x → emit "close"
 * - Two-finger pinch → zoom (clamped to MIN/MAX_SCALE)
 * - Double tap → toggle 1x / 2x
 * - ArrowLeft/Right do nothing here; navigation is the caller's job.
 */
import { ref, watch, onMounted, onUnmounted } from "vue";
import { touchDistance, nextScale, MIN_SCALE } from "@/features/messaging/model/pinch-zoom";

interface Props {
  src: string;
  alt?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

const scale = ref(1);
const translateX = ref(0);
const translateY = ref(0);

const resetTransform = () => {
  scale.value = 1;
  translateX.value = 0;
  translateY.value = 0;
};

// Reset on src change so the next photo starts at 1x.
watch(() => props.src, resetTransform);

let touchStartX = 0;
let touchStartY = 0;
let pinchLastDistance = 0;
let panStartX = 0;
let panStartY = 0;

const onTouchstart = (e: TouchEvent) => {
  if (e.touches.length === 2) {
    pinchLastDistance = touchDistance(
      [e.touches[0].clientX, e.touches[0].clientY],
      [e.touches[1].clientX, e.touches[1].clientY],
    );
    return;
  }
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  if (scale.value > 1) {
    panStartX = translateX.value;
    panStartY = translateY.value;
  }
};

const onTouchmove = (e: TouchEvent) => {
  if (e.touches.length === 2) {
    const d = touchDistance(
      [e.touches[0].clientX, e.touches[0].clientY],
      [e.touches[1].clientX, e.touches[1].clientY],
    );
    scale.value = nextScale(scale.value, pinchLastDistance, d);
    pinchLastDistance = d;
    return;
  }
  if (scale.value > 1) {
    // Divide by scale so 1 finger-pixel of drag = 1 screen-pixel of
    // movement at any zoom — without this the photo accelerates away.
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    translateX.value = panStartX + dx / scale.value;
    translateY.value = panStartY + dy / scale.value;
    return;
  }
  // At 1x: a clear vertical swipe-down dismisses, matching MediaViewer.
  const deltaY = e.touches[0].clientY - touchStartY;
  const deltaX = e.touches[0].clientX - touchStartX;
  if (Math.abs(deltaY) > 80 && Math.abs(deltaY) > Math.abs(deltaX)) {
    emit("close");
  }
};

const onTouchend = (e: TouchEvent) => {
  if (e.touches.length < 2) pinchLastDistance = 0;
  // 2→1 finger: re-seed pan anchor on the remaining finger so the next
  // drag doesn't snap from stale pre-pinch coordinates.
  if (e.touches.length === 1) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    if (scale.value > 1) {
      panStartX = translateX.value;
      panStartY = translateY.value;
    }
    return;
  }
  // Snap back to 1x if a tiny over-pinch left a barely-visible scale.
  if (scale.value < MIN_SCALE + 0.05 && scale.value !== MIN_SCALE) {
    resetTransform();
  }
};

let lastTapTime = 0;
const handleDoubleTap = () => {
  const now = Date.now();
  if (now - lastTapTime < 300) {
    if (scale.value > 1) resetTransform();
    else scale.value = 2;
  }
  lastTapTime = now;
};

// Mouse-wheel zoom for desktop (Electron). Pinch on a Mac trackpad
// already fires wheel events with ctrlKey set by the browser.
const onWheel = (e: WheelEvent) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  scale.value = Math.max(1, Math.min(4, scale.value * factor));
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") emit("close");
};

onMounted(() => {
  document.addEventListener("keydown", handleKeydown);
});
onUnmounted(() => {
  document.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div
    class="relative flex h-full w-full items-center justify-center overflow-hidden touch-none"
    @touchstart.passive="onTouchstart"
    @touchmove.passive="onTouchmove"
    @touchend.passive="onTouchend"
    @click="handleDoubleTap"
    @wheel="onWheel"
  >
    <img
      :src="src"
      :alt="alt ?? ''"
      class="max-h-full max-w-full object-contain select-none"
      :style="{
        transform: `scale(${scale}) translate(${translateX}px, ${translateY}px)`,
        transition: 'transform 80ms ease-out',
      }"
      draggable="false"
    />
  </div>
</template>
