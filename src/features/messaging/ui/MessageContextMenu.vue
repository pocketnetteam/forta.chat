<script setup lang="ts">
import { computed } from "vue";
import type { Message } from "@/entities/chat";
import { ContextMenu } from "@/shared/ui/context-menu";
import type { ContextMenuItem } from "@/shared/ui/context-menu";
import ReactionPicker from "./ReactionPicker.vue";

interface Props {
  show: boolean;
  x: number;
  y: number;
  message: Message | null;
  isOwn: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
  action: [action: string, message: Message];
  react: [emoji: string, message: Message];
  openEmojiPicker: [message: Message];
}>();

// Monochrome SVG icons (Telegram-style, inherit currentColor)
const svg = (d: string, extra = "") =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;

const ICONS = {
  reply:   svg('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>'),
  copy:    svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  forward: svg('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>'),
  edit:    svg('<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  select:  svg('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  pin:     svg('<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>'),
  delete:  svg('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
};

const menuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = [
    { label: "Reply", icon: ICONS.reply, action: "reply" },
    { label: "Copy", icon: ICONS.copy, action: "copy" },
    { label: "Forward", icon: ICONS.forward, action: "forward" },
  ];
  if (props.isOwn) {
    items.push({ label: "Edit", icon: ICONS.edit, action: "edit" });
  }
  items.push({ label: "Select", icon: ICONS.select, action: "select" });
  items.push({ label: "Pin", icon: ICONS.pin, action: "pin" });
  if (props.isOwn) {
    items.push({ label: "Delete", icon: ICONS.delete, action: "delete", danger: true });
  }
  return items;
});

const handleReaction = (emoji: string) => {
  if (props.message) {
    emit("react", emoji, props.message);
  }
  emit("close");
};

const handleAction = (action: string) => {
  if (props.message) {
    emit("action", action, props.message);
  }
};

const handleOpenEmojiPicker = () => {
  if (props.message) {
    emit("openEmojiPicker", props.message);
  }
  emit("close");
};
</script>

<template>
  <ContextMenu
    :show="props.show"
    :x="props.x"
    :y="props.y"
    :items="menuItems"
    @close="emit('close')"
    @select="handleAction"
  >
    <template #header>
      <div class="flex items-center gap-1 border-b border-neutral-grad-0 px-2 py-2">
        <ReactionPicker @select="handleReaction" />
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
          title="More reactions"
          @click="handleOpenEmojiPicker"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" />
            <line x1="12" y1="17" x2="12" y2="20" /><line x1="10.5" y1="18.5" x2="13.5" y2="18.5" />
          </svg>
        </button>
      </div>
    </template>
  </ContextMenu>
</template>
