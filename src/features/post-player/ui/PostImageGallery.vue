<script lang="ts">
// Per-instance counter so galleries opened from different post cards never
// share a back-handler slot. Module-scoped, outside `<script setup>`.
let postImageGalleryInstanceCounter = 0;
</script>

<script setup lang="ts">
/**
 * Fullscreen viewer for the images of one Bastyon post: swipe / arrows /
 * keyboard to page through, pinch / double-tap / wheel zoom and swipe-down to
 * close come from ZoomableImage. Mounted with `v-if` by the caller, so the
 * start index is read once on mount.
 */
import { ZoomableImage } from "@/shared/ui/zoomable-image";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

interface Props {
  images: string[];
  startIndex?: number;
}

const props = withDefaults(defineProps<Props>(), { startIndex: 0 });
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const clampIndex = (i: number) => Math.min(Math.max(i, 0), Math.max(props.images.length - 1, 0));

const currentIndex = ref(clampIndex(props.startIndex));
const currentSrc = computed(() => props.images[currentIndex.value] ?? "");
const hasPrev = computed(() => currentIndex.value > 0);
const hasNext = computed(() => currentIndex.value < props.images.length - 1);

const goPrev = () => {
  if (hasPrev.value) currentIndex.value--;
};
const goNext = () => {
  if (hasNext.value) currentIndex.value++;
};

const handleSwipe = (direction: "next" | "prev") => {
  if (direction === "next") goNext();
  else goPrev();
};

// Escape is handled by ZoomableImage itself.
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === "ArrowLeft") goPrev();
  else if (e.key === "ArrowRight") goNext();
};

onMounted(() => document.addEventListener("keydown", handleKeydown));
onUnmounted(() => document.removeEventListener("keydown", handleKeydown));

useAndroidBackHandler(`post-image-gallery-${++postImageGalleryInstanceCounter}`, 100, () => {
  emit("close");
  return true;
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="currentSrc"
      class="fixed inset-0 z-[60] flex flex-col bg-black safe-all"
      data-testid="post-image-gallery"
      @click.stop
    >
      <!-- Top bar -->
      <div class="flex h-12 shrink-0 items-center justify-between px-4 text-white">
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          :aria-label="t('postPlayer.closeGallery')"
          data-testid="post-image-gallery-close"
          @click="emit('close')"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
        <span v-if="images.length > 1" class="text-sm text-white/60" data-testid="post-image-gallery-counter">
          {{ currentIndex + 1 }} / {{ images.length }}
        </span>
        <div class="w-9" />
      </div>

      <!-- Image -->
      <div class="relative min-h-0 flex-1">
        <ZoomableImage
          :src="currentSrc"
          class="h-full w-full"
          @close="emit('close')"
          @swipe="handleSwipe"
        />

        <!-- Navigation arrows (desktop) -->
        <button
          v-if="hasPrev"
          class="absolute left-4 top-1/2 hidden -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 md:flex"
          :aria-label="t('postPlayer.prevImage')"
          data-testid="post-image-gallery-prev"
          @click.stop="goPrev"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          v-if="hasNext"
          class="absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 md:flex"
          :aria-label="t('postPlayer.nextImage')"
          data-testid="post-image-gallery-next"
          @click.stop="goNext"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    </div>
  </Teleport>
</template>
