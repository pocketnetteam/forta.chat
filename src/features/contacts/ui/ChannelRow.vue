<script setup lang="ts">
import { useChannelStore } from "@/entities/channel";
import type { Channel } from "@/entities/channel";
import { formatRelativeTime } from "@/shared/lib/format";

interface Props {
  channel: Channel;
}

const props = defineProps<Props>();
const emit = defineEmits<{ select: [channel: Channel] }>();

const channelStore = useChannelStore();

const isActive = computed(() => props.channel.address === channelStore.activeChannelAddress);

const previewText = computed(() => {
  if (!props.channel.lastContent) return "";
  const text = props.channel.lastContent.caption || props.channel.lastContent.message || "";
  return text.length > 80 ? text.slice(0, 80) + "..." : text;
});

const handleClick = () => emit("select", props.channel);
</script>

<template>
  <button
    class="channel-row flex h-[68px] w-full cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0 active:bg-neutral-grad-0"
    :class="isActive ? 'bg-color-bg-ac/10' : ''"
    @click="handleClick"
  >
    <div class="relative shrink-0">
      <Avatar :src="channel.avatar" :name="channel.name" size="md" />
      <div class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background-total-theme">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-text-on-main-bg-color">
          <path d="M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1zm16 2a6 6 0 0 0-3-5.2v10.4A6 6 0 0 0 19 12z" />
        </svg>
      </div>
    </div>
    <div class="min-w-0 flex-1">
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-[15px] font-medium text-text-color">{{ channel.name }}</span>
        <span
          v-if="channel.lastContent"
          class="flex shrink-0 items-center gap-0.5 text-xs text-text-on-main-bg-color"
        >
          {{ formatRelativeTime(new Date(channel.lastContent!.time * 1000)) }}
        </span>
      </div>
      <div class="mt-0.5 flex items-center justify-between gap-2">
        <span class="truncate text-sm text-text-on-main-bg-color">
          {{ previewText }}
        </span>
      </div>
    </div>
  </button>
</template>

<style scoped>
.channel-row {
  contain: strict;
  content-visibility: auto;
  contain-intrinsic-size: auto 68px;
}
</style>
