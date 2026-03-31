<script setup lang="ts">
import type { Message } from "@/entities/chat/model/types";
import { useFileDownload } from "@/features/messaging/model/use-file-download";
import { formatDuration } from "@/shared/lib/format";

const props = defineProps<{
  messages: Message[];
}>();

const emit = defineEmits<{
  select: [messageId: string];
  contextmenu: [payload: { message: Message; x: number; y: number }];
}>();
const { t } = useI18n();
const { getState, download } = useFileDownload();

interface MonthGroup {
  label: string;
  messages: Message[];
}

const grouped = computed<MonthGroup[]>(() => {
  const groups: MonthGroup[] = [];
  let currentLabel = "";
  let currentGroup: Message[] = [];

  // Sort newest-first
  const sorted = [...props.messages].sort((a, b) => b.timestamp - a.timestamp);

  for (const msg of sorted) {
    const d = new Date(msg.timestamp);
    const label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (label !== currentLabel) {
      if (currentGroup.length) groups.push({ label: currentLabel, messages: currentGroup });
      currentLabel = label;
      currentGroup = [msg];
    } else {
      currentGroup.push(msg);
    }
  }
  if (currentGroup.length) groups.push({ label: currentLabel, messages: currentGroup });
  return groups;
});

// Auto-download thumbnails
const ensureLoaded = (msg: Message) => {
  const state = getState(msg._key || msg.id);
  if (!state.objectUrl && !state.loading) download(msg);
};
</script>

<template>
  <div v-if="messages.length === 0" class="flex flex-col items-center justify-center py-16">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
    <span class="mt-3 text-sm text-text-on-main-bg-color">{{ t("chatInfo.noMedia") }}</span>
  </div>

  <div v-else>
    <div v-for="group in grouped" :key="group.label" class="mb-2">
      <div class="px-3 pb-1 pt-3 text-[13px] font-medium text-text-on-main-bg-color">
        {{ group.label }}
      </div>
      <div class="grid grid-cols-3 gap-0.5 px-0.5">
        <button
          v-for="msg in group.messages"
          :key="msg.id"
          class="relative aspect-square overflow-hidden rounded-sm bg-neutral-grad-0"
          @click="emit('select', msg.id)"
          @contextmenu.prevent="emit('contextmenu', { message: msg, x: $event.clientX, y: $event.clientY })"
          @vue:mounted="ensureLoaded(msg)"
        >
          <img
            v-if="getState(msg._key || msg.id).objectUrl"
            :src="getState(msg._key || msg.id).objectUrl!"
            alt=""
            class="h-full w-full object-cover"
            loading="lazy"
          />
          <div v-else class="h-full w-full animate-pulse bg-neutral-grad-0" />

          <!-- Video overlay -->
          <template v-if="msg.type === 'video'">
            <div class="absolute inset-0 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="white" class="drop-shadow-lg">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <span
              v-if="msg.fileInfo?.duration"
              class="absolute bottom-1 right-1 rounded-full bg-black/50 px-1.5 py-0.5 text-[10px] text-white"
            >
              {{ formatDuration(msg.fileInfo.duration) }}
            </span>
          </template>
        </button>
      </div>
    </div>
  </div>
</template>
