<!-- src/features/contacts/ui/SwipeableTabs.vue -->
<script setup lang="ts">
const props = defineProps<{
  tabs: string[];
  modelValue: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [tab: string];
  /** Live swipe position in tab units; null once the swipe has settled, so
   *  the tab indicator goes back to following `modelValue`. */
  scrollProgress: [progress: number | null];
}>();

const containerRef = ref<HTMLElement | null>(null);
let programmaticScroll = false;
let scrollEndTimer: ReturnType<typeof setTimeout> | null = null;
let programmaticTimer: ReturnType<typeof setTimeout> | null = null;

const armProgrammaticGuard = (ms: number) => {
  programmaticScroll = true;
  if (programmaticTimer) clearTimeout(programmaticTimer);
  programmaticTimer = setTimeout(() => {
    programmaticScroll = false;
    programmaticTimer = null;
  }, ms);
};

onBeforeUnmount(() => {
  if (scrollEndTimer) clearTimeout(scrollEndTimer);
  if (programmaticTimer) clearTimeout(programmaticTimer);
});

const onScroll = () => {
  const el = containerRef.value;
  if (!el) return;
  if (programmaticScroll) {
    // A smooth scroll across several tabs can outlast the initial guard;
    // keep ignoring it until the events stop, or its tail would drag the
    // indicator back from the tapped tab.
    armProgrammaticGuard(150);
    return;
  }

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
    emit("scrollProgress", null);
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

    // A tap supersedes any swipe still settling.
    if (scrollEndTimer) { clearTimeout(scrollEndTimer); scrollEndTimer = null; }
    emit("scrollProgress", null);
    armProgrammaticGuard(400);
    el.scrollTo({ left: targetLeft, behavior: "smooth" });
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
