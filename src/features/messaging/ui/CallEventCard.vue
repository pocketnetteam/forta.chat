<script setup lang="ts">
import type { Message } from "@/entities/chat";
import { formatTime } from "@/shared/lib/format";

const props = defineProps<{
  message: Message;
  isOwn: boolean;
  tailClass: string;
}>();

const { t } = useI18n();

const missed = computed(() => props.message.callInfo?.missed ?? false);
const isVideo = computed(() => props.message.callInfo?.callType === "video");
const duration = computed(() => props.message.callInfo?.duration ?? 0);

/** First line: just "Incoming call" or "Outgoing call" */
const callTypeLabel = computed(() => {
  return props.isOwn ? t("call.outgoing") : t("call.incomingCall");
});

/** Format seconds → "0:23" or "1:05:03" */
const formatDuration = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
};

/** Second line status: "Missed" or duration */
const statusLabel = computed(() => {
  if (missed.value) return t("call.missed");
  if (duration.value > 0) return formatDuration(duration.value);
  return t("call.ended");
});

const timeStr = computed(() => formatTime(new Date(props.message.timestamp)));
</script>

<template>
  <div
    class="flex items-center gap-3 rounded-bubble px-3 py-2"
    :class="[tailClass, isOwn ? 'bg-chat-bubble-own' : 'bg-chat-bubble-other']"
  >
    <!-- Phone / video icon in circle -->
    <div
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
      :class="missed ? 'bg-red-400/20' : (isOwn ? 'bg-white/20' : 'bg-green-500/15')"
    >
      <!-- Video icon -->
      <svg
        v-if="isVideo"
        width="20" height="20" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        :class="missed ? 'text-red-400' : 'text-green-500'"
      >
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
      <!-- Phone icon -->
      <svg
        v-else
        width="20" height="20" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        :class="missed ? 'text-red-400' : 'text-green-500'"
      >
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
      </svg>
    </div>

    <!-- Text block -->
    <div class="min-w-0 flex-1">
      <!-- Call type label -->
      <div
        class="text-[13px] font-medium leading-tight"
        :class="isOwn ? 'text-text-on-bg-ac-color' : 'text-text-color'"
      >
        {{ callTypeLabel }}
      </div>
      <!-- Status + time -->
      <div class="mt-0.5 flex items-center gap-1.5 text-[11px]">
        <!-- Direction arrow -->
        <span :class="missed ? 'text-red-400' : (isOwn ? 'text-white/60' : 'text-green-500')">
          {{ isOwn ? "↗" : "↙" }}
        </span>
        <span :class="missed ? 'text-red-400' : (isOwn ? 'text-white/60' : 'text-text-on-main-bg-color')">
          {{ statusLabel }}
        </span>
        <span :class="isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'">
          {{ timeStr }}
        </span>
      </div>
    </div>
  </div>
</template>
