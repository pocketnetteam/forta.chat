<script setup lang="ts">
import type { Message } from "@/entities/chat/model/types";
import { formatDate } from "@/shared/lib/format";

const props = defineProps<{
  messages: Message[];
}>();

const emit = defineEmits<{
  contextmenu: [payload: { messageId: string; x: number; y: number }];
}>();

const { t } = useI18n();

const URL_RE = /https?:\/\/[^\s<>]+|www\.[^\s<>]+/g;

interface LinkItem {
  url: string;
  context: string;
  timestamp: number;
  messageId: string;
}

interface MonthGroup {
  label: string;
  items: LinkItem[];
}

const grouped = computed<MonthGroup[]>(() => {
  const seenUrls = new Set<string>();
  const allLinks: LinkItem[] = [];

  // Sort messages newest-first
  const sorted = [...props.messages].sort((a, b) => b.timestamp - a.timestamp);

  for (const msg of sorted) {
    if (!msg.content) continue;
    const matches = msg.content.matchAll(URL_RE);
    for (const m of matches) {
      const url = m[0];
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      allLinks.push({
        url,
        context: msg.content.slice(0, 60),
        timestamp: msg.timestamp,
        messageId: msg.id,
      });
    }
  }

  // Group by month
  const groups: MonthGroup[] = [];
  let currentLabel = "";
  let currentItems: LinkItem[] = [];

  for (const link of allLinks) {
    const d = new Date(link.timestamp);
    const label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (label !== currentLabel) {
      if (currentItems.length) groups.push({ label: currentLabel, items: currentItems });
      currentLabel = label;
      currentItems = [link];
    } else {
      currentItems.push(link);
    }
  }
  if (currentItems.length) groups.push({ label: currentLabel, items: currentItems });
  return groups;
});

function getDomain(url: string): string {
  try {
    return new URL(url.startsWith("www.") ? "https://" + url : url).hostname;
  } catch {
    return url.slice(0, 30);
  }
}

function openLink(url: string): void {
  const href = url.startsWith("www.") ? "https://" + url : url;
  window.open(href, "_blank");
}
</script>

<template>
  <div v-if="grouped.length === 0" class="flex flex-col items-center justify-center py-16">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
    <span class="mt-3 text-sm text-text-on-main-bg-color">{{ t("chatInfo.noLinks") }}</span>
  </div>

  <div v-else>
    <div v-for="group in grouped" :key="group.label" class="mb-1">
      <div class="px-3 pb-1 pt-3 text-[13px] font-medium text-text-on-main-bg-color">
        {{ group.label }}
      </div>
      <button
        v-for="(item, idx) in group.items"
        :key="item.url + idx"
        class="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-neutral-grad-0"
        @click="openLink(item.url)"
        @contextmenu.prevent="emit('contextmenu', { messageId: item.messageId, x: $event.clientX, y: $event.clientY })"
      >
        <!-- Globe icon -->
        <div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-color-bg-ac/10">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="stroke-color-bg-ac">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </div>

        <!-- Info -->
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-color-txt-ac">
            {{ getDomain(item.url) }}
          </div>
          <div class="truncate text-xs text-text-on-main-bg-color">
            {{ item.context }}
          </div>
          <div class="text-xs text-color-txt-gray">
            {{ formatDate(new Date(item.timestamp)) }}
          </div>
        </div>
      </button>
    </div>
  </div>
</template>
