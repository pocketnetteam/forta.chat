<script setup lang="ts">
import type { Message } from "@/entities/chat/model/types";
import { useAuthStore } from "@/entities/auth";
import { useFileDownload } from "@/features/messaging/model/use-file-download";
import { useAudioPlayback } from "@/features/messaging/model/use-audio-playback";
import { formatDate } from "@/shared/lib/format";

const props = defineProps<{
  messages: Message[];
}>();

const emit = defineEmits<{
  contextmenu: [payload: { message: Message; x: number; y: number }];
}>();

const { t } = useI18n();
const authStore = useAuthStore();
const { getState, download } = useFileDownload();

// Month grouping
interface MonthGroup {
  label: string;
  messages: Message[];
}

const grouped = computed<MonthGroup[]>(() => {
  const groups: MonthGroup[] = [];
  let currentLabel = "";
  let currentGroup: Message[] = [];

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

function getSenderName(address: string): string {
  return authStore.getBastyonUserData(address)?.name || address.slice(0, 10);
}

const playback = useAudioPlayback();

const togglePlay = async (msg: Message) => {
  let url = getState(msg._key || msg.id).objectUrl;
  if (!url) {
    const result = await download(msg);
    url = result ?? null;
  }
  if (!url) return;
  playback.togglePlay({
    messageId: msg.id,
    roomId: msg.roomId,
    objectUrl: url,
    duration: msg.fileInfo?.duration ?? 0,
  });
};
</script>

<template>
  <div v-if="messages.length === 0" class="flex flex-col items-center justify-center py-16">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
    <span class="mt-3 text-sm text-text-on-main-bg-color">{{ t("chatInfo.noVoice") }}</span>
  </div>

  <div v-else>
    <div v-for="group in grouped" :key="group.label" class="mb-1">
      <div class="px-3 pb-1 pt-3 text-[13px] font-medium text-text-on-main-bg-color">
        {{ group.label }}
      </div>
      <button
        v-for="msg in group.messages"
        :key="msg.id"
        class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-neutral-grad-0"
        @click="togglePlay(msg)"
        @contextmenu.prevent="emit('contextmenu', { message: msg, x: $event.clientX, y: $event.clientY })"
      >
        <!-- Play/Pause circle -->
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-text-on-main-bg-color/20 text-text-color">
          <!-- Loading -->
          <div
            v-if="getState(msg._key || msg.id).loading"
            class="contain-strict h-5 w-5 animate-spin rounded-full border-2 border-text-on-main-bg-color border-t-transparent"
          />
          <!-- Pause icon -->
          <svg v-else-if="playback.isPlaying(msg.id).value" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
          <!-- Play icon -->
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>

        <!-- Date + sender -->
        <div class="min-w-0 flex-1">
          <div class="text-sm text-text-color">
            {{ formatDate(new Date(msg.timestamp)) }}
          </div>
          <div class="text-xs text-text-on-main-bg-color">
            {{ getSenderName(msg.senderId) }}
          </div>
        </div>
      </button>
    </div>
  </div>
</template>
