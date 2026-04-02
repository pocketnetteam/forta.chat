<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { useChatStore } from "@/entities/chat";
import { useChannelStore } from "@/entities/channel";

type FilterValue = "all" | "personal" | "groups" | "invites" | "channels";

interface Props {
  modelValue: FilterValue;
  scrollProgress?: number;
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
]);

const visibleTabs = computed(() =>
  tabs.value.filter(t => {
    if (t.value === "invites") return chatStore.inviteCount > 0;
    if (t.value === "channels") return channelStore.channels.length > 0;
    return true;
  })
);

const tabRefs = ref<HTMLElement[]>([]);
const scrollContainer = ref<HTMLElement | null>(null);
const indicatorStyle = ref<{ left: string; width: string }>({ left: "0px", width: "0px" });

const updateIndicator = () => {
  const idx = visibleTabs.value.findIndex(t => t.value === props.modelValue);
  const el = tabRefs.value[idx];
  if (el) {
    indicatorStyle.value = {
      left: `${el.offsetLeft + el.offsetWidth * 0.25}px`,
      width: `${el.offsetWidth * 0.5}px`,
    };
    // Scroll active tab into view like Telegram
    el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
};

const interpolatedStyle = computed(() => {
  if (props.scrollProgress == null) return null;
  const tabs = visibleTabs.value;
  const idx = Math.floor(props.scrollProgress);
  const frac = props.scrollProgress - idx;
  const leftEl = tabRefs.value[idx];
  const rightEl = tabRefs.value[Math.min(idx + 1, tabs.length - 1)];
  if (!leftEl || !rightEl) return null;

  const leftCenter = leftEl.offsetLeft + leftEl.offsetWidth * 0.25;
  const rightCenter = rightEl.offsetLeft + rightEl.offsetWidth * 0.25;
  const leftWidth = leftEl.offsetWidth * 0.5;
  const rightWidth = rightEl.offsetWidth * 0.5;

  return {
    left: `${leftCenter + (rightCenter - leftCenter) * frac}px`,
    width: `${leftWidth + (rightWidth - leftWidth) * frac}px`,
  };
});

const activeIndicatorStyle = computed(() => interpolatedStyle.value ?? indicatorStyle.value);

watch(() => props.modelValue, () => nextTick(updateIndicator));
watch(visibleTabs, () => nextTick(updateIndicator));
onMounted(() => nextTick(updateIndicator));

watch(() => props.scrollProgress, () => {
  if (props.scrollProgress == null) return;
  const idx = Math.round(props.scrollProgress);
  const el = tabRefs.value[idx];
  if (el) el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
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
        v-if="tab.value === 'invites' && chatStore.inviteCount > 0"
        class="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-color-bg-ac px-1 text-[10px] font-medium text-white"
      >
        {{ chatStore.inviteCount }}
      </span>
    </button>
    <!-- Sliding indicator -->
    <div
      class="absolute bottom-0 h-0.5 rounded-full bg-color-bg-ac transition-all duration-200 ease-out"
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
