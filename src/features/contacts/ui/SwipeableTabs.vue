<!-- src/features/contacts/ui/SwipeableTabs.vue -->
<script setup lang="ts">
const props = defineProps<{
  tabs: string[];
  modelValue: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [tab: string];
  scrollProgress: [progress: number];
}>();

const containerRef = ref<HTMLElement | null>(null);
let programmaticScroll = false;
let scrollEndTimer: ReturnType<typeof setTimeout> | null = null;
let programmaticTimer: ReturnType<typeof setTimeout> | null = null;

onBeforeUnmount(() => {
  if (scrollEndTimer) clearTimeout(scrollEndTimer);
  if (programmaticTimer) clearTimeout(programmaticTimer);
});

const onScroll = () => {
  const el = containerRef.value;
  if (!el || programmaticScroll) return;

  const progress = el.scrollLeft / el.clientWidth;
  emit("scrollProgress", progress);

  // Debounce discrete tab update (fires after snap settles)
  if (scrollEndTimer) clearTimeout(scrollEndTimer);
  scrollEndTimer = setTimeout(() => {
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    const tab = props.tabs[idx];
    if (tab && tab !== props.modelValue) {
      emit("update:modelValue", tab);
    }
  }, 100);
};

// When tab selected externally (tap on FolderTabs), scroll to it
watch(
  () => props.modelValue,
  (tab) => {
    const idx = props.tabs.indexOf(tab);
    const el = containerRef.value;
    if (idx < 0 || !el) return;

    const targetLeft = idx * el.clientWidth;
    if (Math.abs(el.scrollLeft - targetLeft) < 2) return;

    programmaticScroll = true;
    el.scrollTo({ left: targetLeft, behavior: "smooth" });
    if (programmaticTimer) clearTimeout(programmaticTimer);
    programmaticTimer = setTimeout(() => {
      programmaticScroll = false;
    }, 400);
  },
);

// When tabs array changes (e.g. invites tab disappears), re-snap
watch(
  () => props.tabs.length,
  () => {
    nextTick(() => {
      const el = containerRef.value;
      if (!el) return;
      const idx = props.tabs.indexOf(props.modelValue);
      if (idx >= 0) {
        el.scrollTo({ left: idx * el.clientWidth, behavior: "auto" });
      }
    });
  },
);

// On mount, scroll to the active tab without animation
onMounted(() => {
  const el = containerRef.value;
  if (!el) return;
  const idx = props.tabs.indexOf(props.modelValue);
  if (idx > 0) {
    el.scrollTo({ left: idx * el.clientWidth, behavior: "auto" });
  }
});
</script>

<template>
  <div
    ref="containerRef"
    class="swipeable-tabs flex h-full overflow-y-hidden"
    :class="disabled ? 'overflow-x-hidden' : 'snap-x snap-mandatory overflow-x-auto'"
    @scroll.passive="onScroll"
  >
    <div
      v-for="tab in tabs"
      :key="tab"
      class="h-full w-full flex-none snap-start snap-always"
    >
      <slot :name="tab" />
    </div>
  </div>
</template>

<style scoped>
.swipeable-tabs {
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.swipeable-tabs::-webkit-scrollbar {
  display: none;
}
.swipeable-tabs > div {
  touch-action: pan-y pinch-zoom;
}
.snap-x {
  scroll-snap-type: x mandatory;
}
.snap-start {
  scroll-snap-align: start;
}
.snap-always {
  scroll-snap-stop: always;
}
</style>
