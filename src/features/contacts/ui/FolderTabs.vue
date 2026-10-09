<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useChatStore } from "@/entities/chat";
import { useChannelStore } from "@/entities/channel";
import { isNativePlatform, isLocalAiFeatureEnabled } from "@/shared/lib/platform";

type FilterValue = "all" | "personal" | "groups" | "invites" | "channels" | "ai";

interface Props {
  modelValue: FilterValue;
  scrollProgress?: number | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{ "update:modelValue": [value: FilterValue] }>();
const chatStore = useChatStore();
const channelStore = useChannelStore();
const { t } = useI18n();

const tabs = computed(() => [
  { value: "all" as const, label: t("tabs.all") },
  { value: "personal" as const, label: t("tabs.personal") },
  { value: "groups" as const, label: t("tabs.groups") },
  { value: "invites" as const, label: t("tabs.invites") },
  { value: "channels" as const, label: t("tabs.channels") },
  { value: "ai" as const, label: t("tabs.ai") },
]);

const visibleTabs = computed(() =>
  tabs.value.filter(t => {
    if (t.value === "invites") return chatStore.inviteCount > 0;
    if (t.value === "channels") return channelStore.channels.length > 0;
    // "AI" is a native-only capability (llama-cpp-capacitor has no web
    // build) — live Capacitor check, same rule as ChatSidebar's
    // `visibleTabValues` (plan §7.1). The real `checkSupport()` runs
    // inside the tab itself once opened, not here.
    if (t.value === "ai") return isLocalAiFeatureEnabled && isNativePlatform();
    return true;
  })
);

/** Count shown next to a tab label: pending invites, unread group chats. */
const badgeCount = (tab: FilterValue): number => {
  if (tab === "invites") return chatStore.inviteCount;
  if (tab === "groups") return chatStore.unreadGroupCount;
  return 0;
};

const tabRefs = ref<HTMLElement[]>([]);
const scrollContainer = ref<HTMLElement | null>(null);

// Tab geometry is read from the DOM, which Vue cannot track. Bumped whenever a
// tab's box may have moved (mount, tab set change, font load, badge count,
// resize) so the indicator styles below re-measure instead of keeping the
// geometry of the first render.
const layoutVersion = ref(0);
const remeasure = () => { layoutVersion.value++; };

const tabGeometry = (el: HTMLElement) => ({
  left: el.offsetLeft + el.offsetWidth * 0.25,
  width: el.offsetWidth * 0.5,
});

/** Indicator under the selected tab — the resting state. */
const indicatorStyle = computed(() => {
  void layoutVersion.value;
  const idx = visibleTabs.value.findIndex(t => t.value === props.modelValue);
  const el = tabRefs.value[idx];
  if (!el) return { left: "0px", width: "0px" };
  const { left, width } = tabGeometry(el);
  return { left: `${left}px`, width: `${width}px` };
});

/** Indicator following a live swipe of the list below. */
const interpolatedStyle = computed(() => {
  void layoutVersion.value;
  if (props.scrollProgress == null) return null;
  const tabs = visibleTabs.value;
  const idx = Math.floor(props.scrollProgress);
  const frac = props.scrollProgress - idx;
  const leftEl = tabRefs.value[idx];
  const rightEl = tabRefs.value[Math.min(idx + 1, tabs.length - 1)];
  if (!leftEl || !rightEl) return null;

  const from = tabGeometry(leftEl);
  const to = tabGeometry(rightEl);
  return {
    left: `${from.left + (to.left - from.left) * frac}px`,
    width: `${from.width + (to.width - from.width) * frac}px`,
  };
});

const isFollowingSwipe = computed(() => interpolatedStyle.value !== null);
const activeIndicatorStyle = computed(() => interpolatedStyle.value ?? indicatorStyle.value);

const scrollActiveTabIntoView = () => {
  const idx = visibleTabs.value.findIndex(t => t.value === props.modelValue);
  // Scroll active tab into view like Telegram
  tabRefs.value[idx]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
};

watch(() => props.modelValue, () => nextTick(scrollActiveTabIntoView));
watch(visibleTabs, () => nextTick(() => {
  remeasure();
  scrollActiveTabIntoView();
}));

let resizeObserver: ResizeObserver | null = null;
const observeTabs = () => {
  if (!resizeObserver) return;
  resizeObserver.disconnect();
  if (scrollContainer.value) resizeObserver.observe(scrollContainer.value);
  for (const el of tabRefs.value) if (el) resizeObserver.observe(el);
};
watch(visibleTabs, () => nextTick(observeTabs));

onMounted(() => {
  nextTick(() => {
    remeasure();
    scrollActiveTabIntoView();
  });
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(remeasure);
    observeTabs();
  }
});
onBeforeUnmount(() => resizeObserver?.disconnect());

// Only scroll tab strip into view when near a snap point (avoid competing smooth-scrolls)
watch(() => props.scrollProgress, (val) => {
  if (val == null) return;
  const rounded = Math.round(val);
  if (Math.abs(val - rounded) < 0.05) {
    const el = tabRefs.value[rounded];
    if (el) el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
});
</script>

<template>
  <div ref="scrollContainer" class="folder-tabs relative flex overflow-x-auto border-b border-neutral-grad-0">
    <button
      v-for="(tab, i) in visibleTabs"
      :key="tab.value"
      :ref="(el) => { if (el) tabRefs[i] = el as HTMLElement }"
      class="relative shrink-0 px-4 py-2.5 text-center text-[13px] font-medium whitespace-nowrap transition-colors"
      :class="props.modelValue === tab.value ? 'text-color-bg-ac' : 'text-text-on-main-bg-color hover:text-text-color'"
      @click="emit('update:modelValue', tab.value)"
    >
      {{ tab.label }}
      <span
        v-if="badgeCount(tab.value) > 0"
        class="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-color-bg-ac px-1 text-[10px] font-medium text-white"
      >
        {{ badgeCount(tab.value) }}
      </span>
    </button>
    <!-- Sliding indicator -->
    <div
      class="absolute bottom-0 h-0.5 rounded-full bg-color-bg-ac"
      :class="isFollowingSwipe ? '' : 'transition-all duration-200 ease-out'"
      :style="activeIndicatorStyle"
    />
  </div>
</template>

<style scoped>
.folder-tabs {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.folder-tabs::-webkit-scrollbar {
  display: none;
}
</style>
