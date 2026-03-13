<script setup lang="ts">
import type { Message } from "@/entities/chat";
import { useChatStore, MessageStatus, MessageType } from "@/entities/chat";
import { formatTime } from "@/shared/lib/format";
import { stripMentionAddresses, stripBastyonLinks } from "@/shared/lib/message-format";
import { useFileDownload } from "../model/use-file-download";
import MessageContent from "./MessageContent.vue";
import MessageStatusIcon from "./MessageStatusIcon.vue";
import PollCard from "./PollCard.vue";
import TransferCard from "./TransferCard.vue";
import ReactionRow from "./ReactionRow.vue";
import VoiceMessage from "./VoiceMessage.vue";
import { ref, inject, onMounted } from "vue";
import { useLongPress, useSwipeGesture } from "@/shared/lib/gestures";
import { useThemeStore } from "@/entities/theme";
import { hexDecode } from "@/shared/lib/matrix/functions";

const { t } = useI18n();
const openUserProfile = inject<((address: string) => void) | null>("openUserProfile", null);

interface Props {
  message: Message;
  isOwn: boolean;
  showAvatar: boolean;
  isGroup?: boolean;
  isFirstInGroup?: boolean;
}

const props = withDefaults(defineProps<Props>(), { isGroup: false, isFirstInGroup: false });

/** Tail (pointed corner) only on the last message in a group (= showAvatar) */
const tailClass = computed(() => {
  if (!props.showAvatar) return "";
  return props.isOwn ? "rounded-br-bubble-sm" : "rounded-bl-bubble-sm";
});
const emit = defineEmits<{
  reply: [message: Message];
  contextmenu: [payload: { message: Message; x: number; y: number }];
  openMedia: [message: Message];
  scrollToReply: [messageId: string];
  toggleReaction: [emoji: string, messageId: string];
  addReaction: [message: Message];
  pollVote: [messageId: string, optionId: string];
  pollEnd: [messageId: string];
}>();

const handleToggleReaction = (emoji: string) => {
  emit("toggleReaction", emoji, props.message.id);
};

const handleAddReaction = () => {
  emit("addReaction", props.message);
};

/** Get display name for forwarded message */
const forwardedFromName = computed(() => {
  if (!props.message.forwardedFrom) return "";
  return props.message.forwardedFrom.senderName || chatStore.getDisplayName(props.message.forwardedFrom.senderId);
});

const longPressTriggered = ref(false);
const { onPointerdown: lpPointerdown, onPointermove, onPointerup: lpPointerup, onPointerleave: lpPointerleave } = useLongPress({
  onTrigger: (e) => {
    longPressTriggered.value = true;
    emit("contextmenu", { message: props.message, x: e.clientX, y: e.clientY });
  },
});
const onPointerdown = (e: PointerEvent) => {
  longPressTriggered.value = false;
  lpPointerdown(e);
};
const onPointerup = () => { lpPointerup(); };
const onPointerleave = () => { lpPointerleave(); };

const handleRightClick = (e: MouseEvent) => {
  // .prevent modifier already calls preventDefault
  emit("contextmenu", { message: props.message, x: e.clientX, y: e.clientY });
};

const { offsetX: swipeOffsetX, isSwiping, onTouchstart, onTouchmove, onTouchend } = useSwipeGesture({
  direction: "left",
  threshold: 60,
  maxOffset: 100,
  onTrigger: () => {
    emit("reply", props.message);
  },
});

const swipeStyle = computed(() => ({
  transform: swipeOffsetX.value > 0 ? `translateX(${-swipeOffsetX.value}px)` : undefined,
  transition: isSwiping.value ? "none" : "transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
}));

const swipeArrowOpacity = computed(() => Math.min(swipeOffsetX.value / 60, 1));

const chatStore = useChatStore();
const themeStore = useThemeStore();
const isSelected = computed(() => chatStore.selectedMessageIds.has(props.message.id));

/** Compute image placeholder/display styles using known dimensions */
const imagePlaceholderStyle = computed(() => {
  const fi = props.message.fileInfo;
  const w = fi?.w;
  const h = fi?.h;
  if (w && h) {
    const maxW = 420;
    const maxH = 460;
    const scale = Math.min(maxW / w, maxH / h, 1);
    return { width: `${Math.round(w * scale)}px`, height: `${Math.round(h * scale)}px` };
  }
  return { width: "256px", height: "192px" };
});

const imageStyle = computed(() => {
  const fi = props.message.fileInfo;
  const w = fi?.w;
  const h = fi?.h;
  if (w && h) {
    const maxW = 420;
    const maxH = 460;
    const scale = Math.min(maxW / w, maxH / h, 1);
    return { width: `${Math.round(w * scale)}px`, height: `${Math.round(h * scale)}px` };
  }
  return {};
});

/** Constrain image bubble width to match the image so caption/reply don't stretch it wider */
const imageBubbleStyle = computed(() => {
  const fi = props.message.fileInfo;
  const w = fi?.w;
  const h = fi?.h;
  if (w && h) {
    const maxW = 420;
    const maxH = 460;
    const scale = Math.min(maxW / w, maxH / h, 1);
    return { width: `${Math.round(w * scale)}px` };
  }
  return { width: '256px' };
});

const handleBubbleClick = () => {
  if (chatStore.selectionMode) {
    chatStore.toggleSelection(props.message.id);
  }
};
const { getState, download, saveFile, formatSize } = useFileDownload();

const time = computed(() => formatTime(new Date(props.message.timestamp)));

const isFile = computed(() => props.message.type === MessageType.file);
const hasFileInfo = computed(() => !!props.message.fileInfo);
const fileState = computed(() => getState(props.message.id));

/** Telegram-style sender colors (same palette as Avatar) */
const SENDER_COLORS = ["#E17076", "#FAA774", "#A695E7", "#7BC862", "#6EC9CB", "#65AADD", "#EE7AAE"];
function hashStr(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h); }
const senderColor = computed(() => SENDER_COLORS[hashStr(props.message.senderId) % SENDER_COLORS.length]);

const msgStatus = computed(() => props.message.status);
const isRead = computed(() => props.message.status === MessageStatus.read);
const isSending = computed(() => props.message.status === MessageStatus.sending);

const fileIcon = computed(() => {
  const type = props.message.fileInfo?.type ?? "";
  if (type.startsWith("application/pdf")) return "pdf";
  if (type.includes("zip") || type.includes("archive") || type.includes("rar")) return "zip";
  if (type.includes("word") || type.includes("document")) return "doc";
  if (type.includes("sheet") || type.includes("excel")) return "xls";
  if (type.includes("presentation") || type.includes("powerpoint")) return "ppt";
  if (type.startsWith("text/")) return "txt";
  return "file";
});

// Download image immediately — virtual scroller already handles lazy rendering
onMounted(() => {
  if (props.message.type === MessageType.image && props.message.fileInfo) {
    download(props.message);
  }
});

// Re-download if message changes (virtual scroller recycling)
watch(() => props.message.id, () => {
  if (props.message.type === MessageType.image && props.message.fileInfo) {
    download(props.message);
  }
});

const handleMediaClick = () => {
  if ((props.message.type === MessageType.image || props.message.type === MessageType.video) && fileState.value.objectUrl) {
    emit("openMedia", props.message);
  }
};

const handleFileDownload = async () => {
  if (!props.message.fileInfo) return;
  const url = fileState.value.objectUrl ?? await download(props.message);
  if (url) saveFile(url, props.message.fileInfo.name);
};

const handleVideoAudioLoad = () => {
  if (!props.message.fileInfo) return;
  download(props.message);
};

const handleReply = () => {
  chatStore.replyingTo = {
    id: props.message.id,
    senderId: props.message.senderId,
    content: props.message.content.slice(0, 150),
    type: props.message.type,
  };
};

const replyPreviewText = computed(() => {
  const reply = props.message.replyTo;
  if (!reply) return "";
  if (!reply.senderId && !reply.content) return "Deleted message";
  if (reply.type === MessageType.image) return "Photo";
  if (reply.type === MessageType.video) return "Video";
  if (reply.type === MessageType.audio) return "Voice message";
  if (reply.type === MessageType.file) return reply.content || "File";
  const text = stripBastyonLinks(stripMentionAddresses(reply.content));
  return (text.length > 100 ? text.slice(0, 100) + "\u2026" : text) || "...";
});
</script>

<template>
  <div
    class="group relative flex gap-2 transition-opacity"
    :class="props.isOwn ? 'flex-row-reverse' : 'flex-row'"
    :style="swipeStyle"
    @pointerdown="onPointerdown"
    @pointermove="onPointermove"
    @pointerup="onPointerup"
    @pointerleave="onPointerleave"
    @contextmenu.prevent="handleRightClick"
    @touchstart="onTouchstart"
    @touchmove="onTouchmove"
    @touchend="onTouchend"
  >
    <!-- Swipe reply arrow (behind message) -->
    <div
      v-if="swipeOffsetX > 0"
      class="absolute right-0 top-1/2 flex h-8 w-8 translate-x-10 -translate-y-1/2 items-center justify-center rounded-full bg-color-bg-ac text-white"
      :style="{ opacity: swipeArrowOpacity }"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 17 4 12 9 7" />
        <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
      </svg>
    </div>

    <!-- Selection checkbox -->
    <div v-if="chatStore.selectionMode" class="flex shrink-0 items-center" @click.stop="handleBubbleClick">
      <div
        class="flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors"
        :class="isSelected ? 'border-color-bg-ac bg-color-bg-ac' : 'border-neutral-grad-2'"
      >
        <svg v-if="isSelected" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
    </div>

    <!-- Avatar slot -->
    <div
      v-if="!chatStore.selectionMode && !props.isOwn && props.showAvatar && themeStore.showAvatarsInChat"
      class="shrink-0 cursor-pointer self-end"
      @click.stop="openUserProfile?.(props.message.senderId)"
    >
      <slot name="avatar" />
    </div>
    <div v-else-if="!chatStore.selectionMode && !props.isOwn && themeStore.showAvatarsInChat" class="w-8 shrink-0" />

    <!-- Bubble container -->
    <div class="relative min-w-0 max-w-[80%] overflow-hidden">
      <!-- Reply action (on hover) -->
      <button
        class="absolute top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-text-on-main-bg-color opacity-0 transition-opacity hover:bg-neutral-grad-0 group-hover:flex group-hover:opacity-100"
        :class="props.isOwn ? '-left-8' : '-right-8'"
        :title="t('contextMenu.reply')"
        @click="handleReply"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 17 4 12 9 7" />
          <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
        </svg>
      </button>

      <!-- Deleted message -->
      <div
        v-if="message.deleted"
        class="rounded-bubble px-3 py-2"
        :class="[tailClass, props.isOwn ? 'bg-chat-bubble-own/60' : 'bg-chat-bubble-other/60']"
      >
        <div class="flex items-center gap-1.5 text-sm italic" :class="props.isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="shrink-0">
            <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
          {{ t('message.deleted') }}
        </div>
      </div>

      <!-- Image message -->
      <div
        v-else-if="message.type === MessageType.image && hasFileInfo"
        class="overflow-hidden rounded-bubble"
        :class="[tailClass, props.isOwn ? 'bg-chat-bubble-own' : 'bg-chat-bubble-other', (message.replyTo || message.forwardedFrom) ? 'min-w-[180px]' : '']"
        :style="imageBubbleStyle"
      >
        <!-- Forwarded indicator -->
        <div v-if="message.forwardedFrom" class="truncate px-3 pt-1.5 text-[11px] italic"
          :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
          {{ t("message.forwardedFrom", { name: forwardedFromName }) }}
        </div>
        <!-- Reply preview -->
        <div
          v-if="message.replyTo"
          class="mx-2 mt-1.5 flex cursor-pointer items-start gap-1.5 overflow-hidden rounded-lg px-2 py-1"
          :class="props.isOwn ? 'bg-white/10' : 'bg-black/5'"
          @click.stop="emit('scrollToReply', message.replyTo.id)"
        >
          <div class="w-0.5 shrink-0 self-stretch rounded-full"
            :class="props.isOwn ? 'bg-white/70' : 'bg-color-bg-ac'" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-medium"
              :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
              {{ message.replyTo.senderId ? chatStore.getDisplayName(message.replyTo.senderId) : 'Deleted message' }}
            </div>
            <div class="truncate text-[11px] opacity-70">{{ replyPreviewText }}</div>
          </div>
        </div>
        <div class="relative cursor-pointer" @click="handleMediaClick">
          <div
            v-if="fileState.loading || (!fileState.objectUrl && !fileState.error)"
            class="flex items-center justify-center bg-neutral-grad-0"
            :style="imagePlaceholderStyle"
          >
            <div class="h-8 w-8 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
          </div>
          <div
            v-else-if="fileState.error"
            class="flex items-center justify-center bg-neutral-grad-0 text-xs text-color-bad"
            :style="imagePlaceholderStyle"
          >
            Failed to load image
          </div>
          <img v-else-if="fileState.objectUrl" :src="fileState.objectUrl" :alt="message.fileInfo?.name" class="block max-h-[460px] max-w-full object-cover" :style="imageStyle" />
          <!-- Sending overlay -->
          <div v-if="isSending" class="absolute inset-0 flex items-center justify-center bg-black/30">
            <div class="h-8 w-8 animate-spin rounded-full border-3 border-white border-t-transparent" />
          </div>
          <div v-if="themeStore.showTimestamps && !message.fileInfo?.caption" class="absolute bottom-1 right-2 flex items-center gap-1 rounded-full bg-black/40 px-2 py-0.5">
            <span class="text-[10px] text-white/90">{{ time }}</span>
            <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" light />
          </div>
        </div>

        <!-- Caption -->
        <div
          v-if="message.fileInfo?.caption"
          class="px-3 py-1.5 text-chat-base"
          :class="props.isOwn ? 'text-text-on-bg-ac-color' : 'text-text-color'"
        >
          <MessageContent :text="message.fileInfo.caption" @mention-click="(userId) => openUserProfile?.(hexDecode(userId))" />
          <span
            v-if="themeStore.showTimestamps"
            class="relative -bottom-[3px] ml-2 inline-flex items-center gap-0.5 whitespace-nowrap align-bottom text-[10px]"
            :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'"
          >
            {{ time }}
            <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
          </span>
        </div>

        <!-- Reactions row -->
        <div v-if="message.reactions && Object.keys(message.reactions).length" class="px-2 pb-1">
          <ReactionRow :reactions="message.reactions" :is-own="props.isOwn" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
        </div>

      </div>

      <!-- Video message -->
      <div
        v-else-if="message.type === MessageType.video && hasFileInfo"
        class="overflow-hidden rounded-bubble"
        :class="[tailClass, props.isOwn ? 'bg-chat-bubble-own' : 'bg-chat-bubble-other', (message.replyTo || message.forwardedFrom) ? 'min-w-[180px]' : '']"
        :style="imageBubbleStyle"
      >
        <!-- Forwarded indicator -->
        <div v-if="message.forwardedFrom" class="truncate px-3 pt-1.5 text-[11px] italic"
          :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
          {{ t("message.forwardedFrom", { name: forwardedFromName }) }}
        </div>
        <!-- Reply preview -->
        <div
          v-if="message.replyTo"
          class="mx-2 mt-1.5 flex cursor-pointer items-start gap-1.5 overflow-hidden rounded-lg px-2 py-1"
          :class="props.isOwn ? 'bg-white/10' : 'bg-black/5'"
          @click.stop="emit('scrollToReply', message.replyTo.id)"
        >
          <div class="w-0.5 shrink-0 self-stretch rounded-full"
            :class="props.isOwn ? 'bg-white/70' : 'bg-color-bg-ac'" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-medium"
              :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
              {{ message.replyTo.senderId ? chatStore.getDisplayName(message.replyTo.senderId) : 'Deleted message' }}
            </div>
            <div class="truncate text-[11px] opacity-70">{{ replyPreviewText }}</div>
          </div>
        </div>
        <div class="relative">
          <video v-if="fileState.objectUrl" :src="fileState.objectUrl" controls class="block max-h-[360px] max-w-full" preload="metadata" />
          <div v-else-if="fileState.loading" class="flex h-48 w-64 items-center justify-center bg-neutral-grad-0">
            <div class="h-8 w-8 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
          </div>
          <button v-else class="flex h-48 w-64 items-center justify-center bg-neutral-grad-0 transition-colors hover:bg-neutral-grad-2" @click="handleVideoAudioLoad">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" class="text-color-bg-ac"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          </button>
        </div>
        <div v-if="!message.fileInfo?.caption" class="flex items-center justify-between px-3 py-1.5">
          <span class="truncate text-xs" :class="props.isOwn ? 'text-white/70' : 'text-text-on-main-bg-color'">{{ message.fileInfo?.name }}</span>
          <div v-if="themeStore.showTimestamps" class="flex items-center gap-1" :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
            <span class="text-[10px]">{{ time }}</span>
            <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
          </div>
        </div>
        <!-- Caption -->
        <div
          v-if="message.fileInfo?.caption"
          class="px-3 py-1.5 text-chat-base"
          :class="props.isOwn ? 'text-text-on-bg-ac-color' : 'text-text-color'"
        >
          <MessageContent :text="message.fileInfo.caption" @mention-click="(userId) => openUserProfile?.(hexDecode(userId))" />
          <span
            v-if="themeStore.showTimestamps"
            class="relative -bottom-[3px] ml-2 inline-flex items-center gap-0.5 whitespace-nowrap align-bottom text-[10px]"
            :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'"
          >
            {{ time }}
            <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
          </span>
        </div>
        <!-- Reactions row -->
        <div v-if="message.reactions && Object.keys(message.reactions).length" class="px-2 pb-1">
          <ReactionRow :reactions="message.reactions" :is-own="props.isOwn" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
        </div>
      </div>

      <!-- Audio message -->
      <div
        v-else-if="message.type === MessageType.audio && hasFileInfo"
        class="min-w-[240px] rounded-bubble px-3 py-2"
        :class="[tailClass, props.isOwn ? 'bg-chat-bubble-own text-text-on-bg-ac-color' : 'bg-chat-bubble-other text-text-color']"
      >
        <!-- Forwarded indicator -->
        <div v-if="message.forwardedFrom" class="mb-1 truncate text-[11px] italic"
          :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
          Forwarded from {{ message.forwardedFrom.senderName || chatStore.getDisplayName(message.forwardedFrom.senderId) }}
        </div>
        <!-- Reply preview -->
        <div
          v-if="message.replyTo"
          class="mb-1 flex cursor-pointer items-start gap-1.5 overflow-hidden rounded-lg px-2 py-1"
          :class="props.isOwn ? 'bg-white/10' : 'bg-black/5'"
          @click.stop="emit('scrollToReply', message.replyTo.id)"
        >
          <div class="w-0.5 shrink-0 self-stretch rounded-full"
            :class="props.isOwn ? 'bg-white/70' : 'bg-color-bg-ac'" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-medium"
              :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
              {{ message.replyTo.senderId ? chatStore.getDisplayName(message.replyTo.senderId) : 'Deleted message' }}
            </div>
            <div class="truncate text-[11px] opacity-70">{{ replyPreviewText }}</div>
          </div>
        </div>
        <VoiceMessage :message="message" :is-own="props.isOwn" />
        <div v-if="themeStore.showTimestamps" class="mt-1 flex items-center justify-end gap-1" :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
          <span class="text-[10px]">{{ time }}</span>
          <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
        </div>
        <!-- Reactions row -->
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
      </div>

      <!-- File message -->
      <div
        v-else-if="isFile && hasFileInfo"
        class="rounded-bubble px-3 py-2"
        :class="[tailClass, props.isOwn ? 'bg-chat-bubble-own text-text-on-bg-ac-color' : 'bg-chat-bubble-other text-text-color']"
      >
        <!-- Forwarded indicator -->
        <div v-if="message.forwardedFrom" class="mb-1 truncate text-[11px] italic"
          :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
          Forwarded from {{ message.forwardedFrom.senderName || chatStore.getDisplayName(message.forwardedFrom.senderId) }}
        </div>
        <!-- Reply preview -->
        <div
          v-if="message.replyTo"
          class="mb-1 flex cursor-pointer items-start gap-1.5 overflow-hidden rounded-lg px-2 py-1"
          :class="props.isOwn ? 'bg-white/10' : 'bg-black/5'"
          @click.stop="emit('scrollToReply', message.replyTo.id)"
        >
          <div class="w-0.5 shrink-0 self-stretch rounded-full"
            :class="props.isOwn ? 'bg-white/70' : 'bg-color-bg-ac'" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-medium"
              :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
              {{ message.replyTo.senderId ? chatStore.getDisplayName(message.replyTo.senderId) : 'Deleted message' }}
            </div>
            <div class="truncate text-[11px] opacity-70">{{ replyPreviewText }}</div>
          </div>
        </div>
        <button class="flex w-full items-center gap-3 text-left" @click="handleFileDownload">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" :class="props.isOwn ? 'bg-white/20' : 'bg-color-bg-ac/10'">
            <svg v-if="fileState.loading" class="h-5 w-5 animate-spin" :class="props.isOwn ? 'text-white' : 'text-color-bg-ac'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="31.4 31.4" /></svg>
            <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="props.isOwn ? 'text-white' : 'text-color-bg-ac'">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{{ message.fileInfo?.name }}</p>
            <p class="text-xs opacity-60">
              {{ formatSize(message.fileInfo?.size ?? 0) }}
              <template v-if="fileIcon !== 'file'"> &middot; {{ fileIcon.toUpperCase() }}</template>
            </p>
          </div>
          <svg v-if="!fileState.loading" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 opacity-60">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        <p v-if="fileState.error" class="mt-1 text-xs text-color-bad">{{ fileState.error }}</p>
        <div v-if="message.fileInfo?.caption" class="mt-1 text-chat-base opacity-90">
          <MessageContent :text="message.fileInfo.caption" @mention-click="(userId) => openUserProfile?.(hexDecode(userId))" />
        </div>
        <div v-if="themeStore.showTimestamps" class="mt-1 flex items-center justify-end gap-1" :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
          <span class="text-[10px]">{{ time }}</span>
          <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
        </div>
        <!-- Reactions row -->
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
      </div>

      <!-- Poll message -->
      <div
        v-else-if="message.type === MessageType.poll && message.pollInfo"
        class="rounded-bubble px-3 py-2"
        :class="[tailClass, props.isOwn ? 'bg-chat-bubble-own text-text-on-bg-ac-color' : 'bg-chat-bubble-other text-text-color']"
      >
        <!-- Sender name in groups -->
        <div
          v-if="props.isGroup && !props.isOwn && props.isFirstInGroup"
          class="mb-0.5 cursor-pointer text-sm font-semibold"
          :style="{ color: senderColor }"
          @click.stop="openUserProfile?.(message.senderId)"
        >
          {{ chatStore.getDisplayName(message.senderId) }}
        </div>
        <PollCard
          :message="message"
          :is-own="props.isOwn"
          @vote="(optionId: string) => emit('pollVote', message.id, optionId)"
          @end="emit('pollEnd', message.id)"
        />
        <div v-if="themeStore.showTimestamps" class="mt-1 flex items-center justify-end gap-1" :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
          <span class="text-[10px]">{{ time }}</span>
          <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
        </div>
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
      </div>

      <!-- Transfer message -->
      <div
        v-else-if="message.type === MessageType.transfer && message.transferInfo"
        class="rounded-bubble px-3 py-2"
        :class="[tailClass, props.isOwn ? 'bg-chat-bubble-own text-text-on-bg-ac-color' : 'bg-chat-bubble-other text-text-color']"
      >
        <div
          v-if="props.isGroup && !props.isOwn && props.isFirstInGroup"
          class="mb-0.5 cursor-pointer text-sm font-semibold"
          :style="{ color: senderColor }"
          @click.stop="openUserProfile?.(message.senderId)"
        >
          {{ chatStore.getDisplayName(message.senderId) }}
        </div>
        <TransferCard :message="message" :is-own="props.isOwn" />
        <div v-if="themeStore.showTimestamps" class="mt-1 flex items-center justify-end gap-1" :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
          <span class="text-[10px]">{{ time }}</span>
          <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
        </div>
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
      </div>

      <!-- Text message (default) -->
      <div
        v-else
        class="rounded-bubble px-3 py-1.5"
        :class="[tailClass, props.isOwn ? 'bg-chat-bubble-own text-text-on-bg-ac-color' : 'bg-chat-bubble-other text-text-color']"
      >
        <!-- Sender name in groups -->
        <div
          v-if="props.isGroup && !props.isOwn && props.isFirstInGroup"
          class="mb-0.5 cursor-pointer text-sm font-semibold"
          :style="{ color: senderColor }"
          @click.stop="openUserProfile?.(message.senderId)"
        >
          {{ chatStore.getDisplayName(message.senderId) }}
        </div>

        <!-- Forwarded indicator -->
        <div v-if="message.forwardedFrom" class="mb-0.5 truncate text-[11px] italic"
          :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
          Forwarded from {{ message.forwardedFrom.senderName || chatStore.getDisplayName(message.forwardedFrom.senderId) }}
        </div>

        <!-- Reply preview -->
        <div
          v-if="message.replyTo"
          class="mb-1 flex cursor-pointer items-start gap-1.5 overflow-hidden rounded-lg px-2 py-1"
          :class="props.isOwn ? 'bg-white/10' : 'bg-black/5'"
          @click.stop="emit('scrollToReply', message.replyTo.id)"
        >
          <div class="w-0.5 shrink-0 self-stretch rounded-full"
            :class="props.isOwn ? 'bg-white/70' : 'bg-color-bg-ac'" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-medium"
              :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
              {{ message.replyTo.senderId ? chatStore.getDisplayName(message.replyTo.senderId) : 'Deleted message' }}
            </div>
            <div class="truncate text-[11px] opacity-70">{{ replyPreviewText }}</div>
          </div>
        </div>

        <!-- Message content with parsed links/mentions -->
        <div class="text-chat-base">
          <MessageContent :text="props.message.content" :is-own="props.isOwn" :link-preview="props.message.linkPreview" @mention-click="(userId) => openUserProfile?.(hexDecode(userId))" />
          <!-- Inline timestamp (Telegram-style float) -->
          <span
            v-if="themeStore.showTimestamps"
            class="relative -bottom-[3px] ml-2 inline-flex items-center gap-0.5 whitespace-nowrap align-bottom text-[10px]"
            :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'"
          >
            <span v-if="message.edited" class="italic">edited</span>
            {{ time }}
            <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
          </span>
        </div>

        <!-- Reactions row -->
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
      </div>
    </div>
  </div>
</template>

