<script setup lang="ts">
import { computed, watch, reactive } from "vue";
import { useThemeStore } from "@/entities/theme";

interface ReactionData {
  count: number;
  users: string[];
  myEventId?: string;
}

interface Props {
  reactions: Record<string, ReactionData>;
  isOwn: boolean;
  myAddress?: string;
  messageId?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  toggle: [emoji: string];
  addReaction: [];
}>();

const themeStore = useThemeStore();

// Module-level map: survives DynamicScroller component recycling
const pendingMap = reactive(new Map<string, number>());

const dataHasMyReaction = computed(() => {
  return Object.values(props.reactions).some(r =>
    !!r.myEventId || (props.myAddress ? r.users.includes(props.myAddress) : false),
  );
});

// Clear pending when real data arrives or after timeout
watch(dataHasMyReaction, (val) => {
  if (val && props.messageId) {
    pendingMap.delete(props.messageId);
  }
});

const hasMyReaction = computed(() => {
  if (props.messageId && pendingMap.has(props.messageId)) return true;
  return dataHasMyReaction.value;
});

const onToggle = (emoji: string) => {
  if (!dataHasMyReaction.value && props.messageId) {
    pendingMap.set(props.messageId, Date.now());
    // Safety cleanup after 5s in case data never arrives
    setTimeout(() => pendingMap.delete(props.messageId!), 5000);
  }
  emit("toggle", emoji);
};

const MAX_VISIBLE = 5;

const visibleReactions = computed(() => {
  const entries = Object.entries(props.reactions);
  return entries.slice(0, MAX_VISIBLE);
});

const overflowCount = computed(() => {
  const total = Object.keys(props.reactions).length;
  return total > MAX_VISIBLE ? total - MAX_VISIBLE : 0;
});

const chipClass = (isMine: boolean) => {
  if (props.isOwn) {
    return isMine
      ? "bg-white/25 text-white border border-white/30"
      : "bg-white/10 text-white/80 border border-transparent hover:bg-white/20";
  }
  return isMine
    ? "bg-color-bg-ac/20 text-color-bg-ac border border-color-bg-ac/30"
    : "bg-neutral-grad-0 text-text-on-main-bg-color border border-transparent hover:bg-neutral-grad-2";
};
</script>

<template>
  <div v-if="Object.keys(reactions).length" class="mt-1 flex flex-wrap gap-1">
    <button
      v-for="[emoji, data] in visibleReactions"
      :key="emoji"
      type="button"
      class="reaction-chip inline-flex cursor-pointer items-center gap-0.5 rounded-full px-2 py-1 text-xs transition-colors"
      :class="[chipClass(!!data.myEventId || (myAddress ? data.users.includes(myAddress) : false)), themeStore.animationsEnabled ? 'animate-reaction' : '']"
      @click.stop="onToggle(emoji)"
    >
      <span>{{ emoji }}</span>
      <span v-if="data.count > 0" class="tabular-nums">{{ data.count }}</span>
    </button>

    <!-- Overflow indicator -->
    <span
      v-if="overflowCount > 0"
      class="inline-flex items-center rounded-full px-1.5 py-0.5 text-xs"
      :class="isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'"
    >
      +{{ overflowCount }}
    </span>

    <!-- Add reaction button (hidden when user already has a reaction) -->
    <button
      v-if="!hasMyReaction"
      type="button"
      class="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs transition-colors"
      :class="isOwn ? 'text-white/50 hover:bg-white/10 hover:text-white/80' : 'text-text-on-main-bg-color hover:bg-neutral-grad-0'"
      @click.stop="emit('addReaction')"
    >
      +
    </button>
  </div>
</template>

<style>
@keyframes reaction-pop {
  0% { transform: scale(0); }
  60% { transform: scale(1.2); }
  100% { transform: scale(1); }
}
@media (prefers-reduced-motion: no-preference) {
  .animate-reaction {
    animation: reaction-pop 0.25s ease;
  }
}
</style>
