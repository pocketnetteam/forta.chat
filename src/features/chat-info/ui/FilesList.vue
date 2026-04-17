<script setup lang="ts">
import type { Message } from "@/entities/chat/model/types";
import { useFileDownload } from "@/features/messaging/model/use-file-download";
import { formatDate } from "@/shared/lib/format";

const props = defineProps<{
  messages: Message[];
}>();

const emit = defineEmits<{
  contextmenu: [payload: { message: Message; x: number; y: number }];
}>();

const { t } = useI18n();
const { getState, download, saveFile, formatSize } = useFileDownload();

// File type color by extension
function getFileColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "#ef4444";
  if (["xlsx", "xls", "csv"].includes(ext)) return "#22c55e";
  if (["doc", "docx", "txt", "rtf"].includes(ext)) return "#3b82f6";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "#eab308";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "#a855f7";
  return "#9ca3af";
}

// Month grouping (same pattern as MediaGrid)
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

// Click handler: download and save
const handleClick = async (msg: Message) => {
  const state = getState(msg._key || msg.id);
  if (state.objectUrl) {
    await saveFile(state.objectUrl, msg.fileInfo?.name ?? "file", msg.fileInfo?.type);
    return;
  }
  const url = await download(msg);
  if (url) await saveFile(url, msg.fileInfo?.name ?? "file", msg.fileInfo?.type);
};
</script>

<template>
  <div v-if="messages.length === 0" class="flex flex-col items-center justify-center py-16">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
    <span class="mt-3 text-sm text-text-on-main-bg-color">{{ t("chatInfo.noFiles") }}</span>
  </div>

  <div v-else>
    <div v-for="group in grouped" :key="group.label" class="mb-1">
      <div class="px-3 pb-1 pt-3 text-[13px] font-medium text-text-on-main-bg-color">
        {{ group.label }}
      </div>
      <button
        v-for="msg in group.messages"
        :key="msg.id"
        class="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-neutral-grad-0"
        @click="handleClick(msg)"
        @contextmenu.prevent="emit('contextmenu', { message: msg, x: $event.clientX, y: $event.clientY })"
      >
        <!-- File type icon -->
        <div
          class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg"
          :style="{ backgroundColor: getFileColor(msg.fileInfo?.name ?? '') + '20' }"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            :style="{ stroke: getFileColor(msg.fileInfo?.name ?? '') }"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>

        <!-- Info -->
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-text-color">
            {{ msg.fileInfo?.name ?? "file" }}
          </div>
          <div class="flex items-center gap-2 text-xs text-text-on-main-bg-color">
            <span>{{ formatSize(msg.fileInfo?.size ?? 0) }}</span>
            <span>&middot;</span>
            <span>{{ formatDate(new Date(msg.timestamp)) }}</span>
          </div>
        </div>

        <!-- Loading indicator -->
        <div
          v-if="getState(msg._key || msg.id).loading"
          class="contain-strict h-4 w-4 animate-spin rounded-full border-2 border-neutral-grad-0 border-t-color-bg-ac"
        />
      </button>
    </div>
  </div>
</template>
