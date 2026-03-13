<script setup lang="ts">
import { ref, nextTick, watch, computed, onBeforeUnmount } from "vue";
import { useChatStore, MessageType } from "@/entities/chat";
import { useThemeStore } from "@/entities/theme";
import { stripMentionAddresses, stripBastyonLinks } from "@/shared/lib/message-format";
import { getDraft, saveDraft, clearDraft } from "@/shared/lib/drafts";
import { useMessages } from "../model/use-messages";
import { useLinkPreview } from "../model/use-link-preview";
import { useI18n } from "@/shared/lib/i18n";
import { useMediaUpload } from "../model/use-media-upload";
import { usePasteDrop } from "../model/use-paste-drop";
import EmojiPicker from "./EmojiPicker.vue";
import AttachmentPanel from "./AttachmentPanel.vue";
import MediaPreview from "./MediaPreview.vue";
import PollCreator from "./PollCreator.vue";
import VoiceRecorder from "./VoiceRecorder.vue";
import { useVoiceRecorder } from "../model/use-voice-recorder";
import { useMentionAutocomplete } from "../model/use-mention-autocomplete";
import MentionAutocomplete from "./MentionAutocomplete.vue";

const props = defineProps<{
  /** Show "Send PKOIN" in attachment menu (1:1 + wallet available) */
  showDonate?: boolean;
}>();

const emit = defineEmits<{ donate: [] }>();

const chatStore = useChatStore();
const themeStore = useThemeStore();
const { t } = useI18n();
const { sendMessage, sendFile, sendImage, sendAudio, sendReply, editMessage, setTyping, sendPoll, sendGif } = useMessages();
const mediaUpload = useMediaUpload();
const pasteDrop = usePasteDrop({
  onMediaFiles: (files) => mediaUpload.addFiles(files),
  onOtherFiles: async (files) => {
    sending.value = true;
    try {
      for (const file of files) {
        await sendFile(file);
      }
    } finally {
      sending.value = false;
    }
  },
});
const voiceRecorder = useVoiceRecorder();

const text = ref("");
const linkPreview = useLinkPreview(text);
const textareaRef = ref<HTMLTextAreaElement>();
const mention = useMentionAutocomplete(text, textareaRef);
const fileInputRef = ref<HTMLInputElement>();
const sending = ref(false);
let typingTimeout: ReturnType<typeof setTimeout> | null = null;

let draftTimer: ReturnType<typeof setTimeout> | undefined;
watch(text, (val) => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const roomId = chatStore.activeRoomId;
    if (roomId) saveDraft(roomId, val);
  }, 500);
});

// Save draft before switching rooms, restore draft for new room.
// immediate: true so when opening a chat we restore draft into the input (watch runs on mount).
watch(
  () => chatStore.activeRoomId,
  (newId, oldId) => {
    if (oldId) saveDraft(oldId, text.value);
    text.value = newId ? getDraft(newId) : "";
    mention.clearMentions();
    chatStore.editingMessage = null;
    chatStore.replyingTo = null;
    nextTick(() => {
      if (textareaRef.value) textareaRef.value.style.height = "auto";
    });
  },
  { immediate: true }
);

/** Save draft on blur so Esc / click outside doesn't lose text before debounce */
const saveDraftOnBlur = () => {
  const roomId = chatStore.activeRoomId;
  if (roomId) saveDraft(roomId, text.value);
};

/** Save draft when component unmounts (e.g. Esc closed chat before watch ran) */
onBeforeUnmount(() => {
  const roomId = chatStore.activeRoomId;
  if (roomId) saveDraft(roomId, text.value);
});

// Watch for edit mode
watch(() => chatStore.editingMessage, (editing) => {
  if (editing) {
    text.value = editing.content;
    nextTick(() => {
      textareaRef.value?.focus();
      autoResize();
    });
  }
}, { immediate: true });

// Auto-focus textarea when replying
watch(() => chatStore.replyingTo, (reply) => {
  if (reply) {
    nextTick(() => textareaRef.value?.focus());
  }
});

const isEditing = computed(() => !!chatStore.editingMessage);

const cancelEdit = () => {
  chatStore.editingMessage = null;
  const roomId = chatStore.activeRoomId;
  text.value = roomId ? getDraft(roomId) : "";
  nextTick(() => {
    if (textareaRef.value) textareaRef.value.style.height = "auto";
  });
};

/** Auto-resize textarea to fit content (1 to 6 rows) */
const autoResize = () => {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  const lineHeight = 24; // ~text-base line height
  const maxHeight = lineHeight * 6;
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
};

const handleSend = () => {
  if (!text.value.trim()) return;
  const rawText = mention.resolveText();
  if (isEditing.value) {
    editMessage(chatStore.editingMessage!.id, rawText);
    chatStore.editingMessage = null;
  } else if (chatStore.replyingTo) {
    sendReply(rawText, linkPreview.activePreview.value ?? undefined);
  } else {
    sendMessage(rawText, linkPreview.activePreview.value ?? undefined);
  }
  text.value = "";
  mention.clearMentions();
  const roomId = chatStore.activeRoomId;
  if (roomId) clearDraft(roomId);
  setTyping(false);
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.style.height = "auto";
    }
  });
};

const handleKeydown = (e: KeyboardEvent) => {
  if (mention.handleKeydown(e)) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
};

const handleInput = () => {
  autoResize();
  mention.onCursorChange();
  setTyping(true);
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    setTyping(false);
  }, 5000);
};

const showAttachmentPanel = ref(false);
const showPollCreator = ref(false);

const handleCreatePoll = (question: string, options: string[]) => {
  showPollCreator.value = false;
  sendPoll(question, options);
};
const attachBtnRef = ref<HTMLElement>();
const attachmentPanelPos = ref({ x: 0, y: 0 });
const photoInputRef = ref<HTMLInputElement>();

const toggleAttachmentPanel = () => {
  if (attachBtnRef.value) {
    const rect = attachBtnRef.value.getBoundingClientRect();
    attachmentPanelPos.value = { x: rect.left + rect.width / 2, y: rect.top };
  }
  showAttachmentPanel.value = !showAttachmentPanel.value;
};

const openFilePicker = () => {
  fileInputRef.value?.click();
};

const openPhotoPicker = () => {
  photoInputRef.value?.click();
};

const handlePhotoSelect = (e: Event) => {
  const target = e.target as HTMLInputElement;
  const files = target.files;
  if (!files?.length) return;
  mediaUpload.addFiles(files);
  target.value = "";
};

const handleFileSelect = async (e: Event) => {
  const target = e.target as HTMLInputElement;
  const files = target.files;
  if (!files?.length) return;

  sending.value = true;
  try {
    for (const file of Array.from(files)) {
      await sendFile(file);
    }
  } finally {
    sending.value = false;
    target.value = "";
  }
};

const handleMediaSend = async () => {
  if (mediaUpload.files.value.length === 0) return;
  mediaUpload.sending.value = true;
  try {
    const files = mediaUpload.files.value;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const isLast = i === files.length - 1;
      const captionOpts = isLast && mediaUpload.caption.value
        ? { caption: mediaUpload.caption.value, captionAbove: mediaUpload.captionAbove.value }
        : {};

      if (f.type === "image") {
        await sendImage(f.file, captionOpts);
      } else {
        await sendFile(f.file);
      }
    }
  } finally {
    mediaUpload.clear();
  }
};

const cancelReply = () => {
  chatStore.replyingTo = null;
};

const replyInputPreviewText = computed(() => {
  const reply = chatStore.replyingTo;
  if (!reply) return "";
  if (reply.type === MessageType.image) return "Photo";
  if (reply.type === MessageType.video) return "Video";
  if (reply.type === MessageType.audio) return "Voice message";
  if (reply.type === MessageType.file) return reply.content || "File";
  const text = stripBastyonLinks(stripMentionAddresses(reply.content));
  return (text.length > 100 ? text.slice(0, 100) + "\u2026" : text) || "...";
});

// Voice recording handlers
const handleVoiceSend = async () => {
  const result = await voiceRecorder.stopAndSend();
  if (result) {
    await sendAudio(result.file, { duration: result.duration, waveform: result.waveform });
  }
};

const handleVoicePreviewSend = async () => {
  const result = await voiceRecorder.sendPreview();
  if (result) {
    await sendAudio(result.file, { duration: result.duration, waveform: result.waveform });
  }
};

const showEmojiPicker = ref(false);
const emojiPickerPos = ref({ x: 0, y: 0 });

/** Expose methods for ChatWindow drag-and-drop integration */
defineExpose({
  addMediaFiles: (files: File[]) => mediaUpload.addFiles(files),
  sendOtherFiles: async (files: File[]) => {
    sending.value = true;
    try {
      for (const file of files) {
        await sendFile(file);
      }
    } finally {
      sending.value = false;
    }
  },
});

const insertEmoji = (emoji: string) => {
  const el = textareaRef.value;
  if (el) {
    const start = el.selectionStart ?? text.value.length;
    const end = el.selectionEnd ?? text.value.length;
    text.value = text.value.slice(0, start) + emoji + text.value.slice(end);
    nextTick(() => {
      el.selectionStart = el.selectionEnd = start + emoji.length;
      el.focus();
      autoResize();
    });
  } else {
    text.value += emoji;
  }
  themeStore.addRecentEmoji(emoji);
  // In input mode, picker stays open — user closes by clicking outside
};

const handleGifSelect = async (gif: { gifUrl: string; width: number; height: number; title: string }) => {
  showEmojiPicker.value = false;
  await sendGif(gif.gifUrl, { w: gif.width, h: gif.height, title: gif.title });
};

const handleKitchenSelect = async (imageUrl: string) => {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return;
    const blob = await response.blob();
    const file = new File([blob], "emoji-kitchen.png", { type: blob.type || "image/png" });
    await sendImage(file);
  } catch (e) {
    console.error("Failed to send kitchen emoji:", e);
  }
};
</script>

<template>
  <div class="border-t border-neutral-grad-0 bg-background-total-theme">
    <!-- Editing bar -->
    <transition name="input-bar">
      <div
        v-if="isEditing"
        class="mx-auto flex max-w-6xl items-center gap-2 border-b border-neutral-grad-0 px-3 py-2"
      >
        <div class="flex h-8 w-8 items-center justify-center text-color-bg-ac">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-xs font-medium text-color-bg-ac">Editing</div>
          <div class="truncate text-xs text-text-on-main-bg-color">{{ chatStore.editingMessage?.content }}</div>
        </div>
        <button
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0"
          aria-label="Cancel editing"
          @click="cancelEdit"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </div>
    </transition>

    <!-- Reply preview bar -->
    <transition name="input-bar">
      <div
        v-if="!isEditing && chatStore.replyingTo"
        class="mx-auto flex max-w-6xl items-center gap-2 border-b border-neutral-grad-0 px-3 py-2"
      >
        <div class="h-8 w-0.5 shrink-0 rounded-full bg-color-bg-ac" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs font-medium text-color-bg-ac">
            {{ chatStore.getDisplayName(chatStore.replyingTo.senderId) }}
          </div>
          <div class="truncate text-xs text-text-on-main-bg-color">
            {{ replyInputPreviewText }}
          </div>
        </div>
        <button
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0"
          aria-label="Cancel reply"
          @click="cancelReply"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </div>
    </transition>

    <!-- Link preview bar -->
    <transition name="input-bar">
      <div
        v-if="!isEditing && !chatStore.replyingTo && (linkPreview.loading.value || linkPreview.activePreview.value)"
        class="mx-auto flex max-w-6xl items-center gap-2 border-b border-neutral-grad-0 px-3 py-2"
      >
        <div class="flex h-8 w-8 shrink-0 items-center justify-center text-text-on-main-bg-color/40">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </div>
        <div class="h-8 w-0.5 shrink-0 rounded-full bg-color-bg-ac" />
        <div class="min-w-0 flex-1">
          <template v-if="linkPreview.loading.value">
            <div class="text-xs font-medium text-text-on-main-bg-color/60">{{ t('linkPreview.loading') }}</div>
            <div class="truncate text-xs text-text-on-main-bg-color/40">{{ linkPreview.lastUrl.value }}</div>
          </template>
          <template v-else-if="linkPreview.activePreview.value">
            <div class="truncate text-xs font-medium text-text-on-main-bg-color/60">
              {{ linkPreview.activePreview.value.siteName || linkPreview.activePreview.value.title || 'Link' }}
            </div>
            <div class="truncate text-xs text-text-on-main-bg-color/40">
              {{ linkPreview.activePreview.value.description || linkPreview.activePreview.value.title || linkPreview.activePreview.value.url }}
            </div>
          </template>
        </div>
        <button
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0"
          :aria-label="t('linkPreview.linkPreview')"
          @click="linkPreview.dismiss()"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </div>
    </transition>

    <!-- Voice recorder (replaces recording bar when active) -->
    <VoiceRecorder
      v-if="voiceRecorder.state.value !== 'idle'"
      :state="voiceRecorder.state.value"
      :duration="voiceRecorder.duration.value"
      :waveform-data="voiceRecorder.waveformData.value"
      :recorded-blob="voiceRecorder.recordedBlob.value"
      @start="voiceRecorder.startRecording()"
      @stop-and-send="handleVoiceSend"
      @stop-and-preview="voiceRecorder.stopAndPreview()"
      @send-preview="handleVoicePreviewSend"
      @lock="voiceRecorder.lock()"
      @cancel="voiceRecorder.cancel()"
    />

    <!-- Input row -->
    <div v-else class="relative mx-auto flex max-w-6xl items-end gap-1.5 px-2 py-2">
      <!-- Mention autocomplete dropdown -->
      <MentionAutocomplete
        v-if="mention.active.value && mention.filteredMembers.value.length > 0 && chatStore.activeRoom?.isGroup"
        :members="mention.filteredMembers.value"
        :selected-index="mention.selectedIndex.value"
        @select="mention.insertMention"
      />
      <!-- Hidden file inputs -->
      <input
        ref="photoInputRef"
        type="file"
        class="hidden"
        multiple
        accept="image/*,video/*"
        @change="handlePhotoSelect"
      />
      <input
        ref="fileInputRef"
        type="file"
        class="hidden"
        multiple
        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,.rar,.7z"
        @change="handleFileSelect"
      />

      <!-- Emoji button (left of textarea) -->
      <button
        class="btn-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color/60 transition-colors hover:text-text-on-main-bg-color"
        :title="t('message.emoji')"
        aria-label="Open emoji picker"
        @click="(e: MouseEvent) => { const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); emojiPickerPos = { x: rect.left, y: rect.top }; showEmojiPicker = !showEmojiPicker; }"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
      </button>

      <!-- Auto-resizing textarea -->
      <textarea
        ref="textareaRef"
        v-model="text"
        :placeholder="t('message.placeholder')"
        aria-label="Type a message"
        rows="1"
        class="flex-1 resize-none rounded-2xl bg-chat-input-bg px-4 py-2.5 text-base leading-[24px] text-text-color outline-none transition-shadow duration-200 placeholder:text-neutral-grad-2 focus:ring-2 focus:ring-color-bg-ac/30"
        :disabled="sending"
        @keydown="handleKeydown"
        @input="handleInput"
        @blur="saveDraftOnBlur"
        @paste="pasteDrop.handlePaste"
        @click="mention.onCursorChange()"
        @keyup="mention.onCursorChange()"
      />

      <!-- PKOIN send button (right of textarea, before attach) -->
      <button
        v-if="props.showDonate"
        class="btn-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-color-txt-ac/60 transition-colors hover:text-color-txt-ac"
        :disabled="sending"
        :title="t('wallet.sendPkoin')"
        aria-label="Send PKOIN"
        @click="emit('donate')"
      >
        <svg width="20" height="20" viewBox="0 0 18 18" fill="currentColor">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M17.2584 1.97869L15.182 0L12.7245 2.57886C11.5308 1.85218 10.1288 1.43362 8.62907 1.43362C7.32722 1.43362 6.09904 1.74902 5.01676 2.30756L2.81787 6.45386e-05L0.741455 1.97875L2.73903 4.07498C1.49651 5.46899 0.741455 7.30694 0.741455 9.32124C0.741455 11.1753 1.38114 12.8799 2.45184 14.2264L0.741455 16.0213L2.81787 18L4.61598 16.1131C5.79166 16.8092 7.1637 17.2088 8.62907 17.2088C10.2903 17.2088 11.8317 16.6953 13.1029 15.8182L15.182 18L17.2584 16.0213L15.1306 13.7884C16.0049 12.5184 16.5167 10.9796 16.5167 9.32124C16.5167 7.50123 15.9003 5.8252 14.8648 4.49052L17.2584 1.97869ZM3.5551 9.32124C3.5551 12.1235 5.82679 14.3952 8.62907 14.3952C11.4313 14.3952 13.703 12.1235 13.703 9.32124C13.703 6.51896 11.4313 4.24727 8.62907 4.24727C5.82679 4.24727 3.5551 6.51896 3.5551 9.32124Z" />
        </svg>
      </button>

      <!-- Attachment button (right of textarea) -->
      <button
        ref="attachBtnRef"
        class="btn-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color/60 transition-colors hover:text-text-on-main-bg-color"
        :disabled="sending"
        :title="t('message.attach')"
        aria-label="Attach file"
        @click="toggleAttachmentPanel"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>

      <!-- Send / Confirm edit button (morphs with mic) -->
      <!-- Note: VoiceRecorder has multiple root elements (v-if/v-else chain) which
           breaks <transition mode="out-in"> — the leave callback never fires so the
           entering element never mounts. Fix: inline the idle mic button as a plain
           <button> so both transition children are single-root native elements. -->
      <transition name="btn-morph" mode="out-in">
        <button
          v-if="text.trim() || sending"
          key="send"
          class="send-btn flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-white transition-all hover:bg-color-bg-ac-1 disabled:opacity-50"
          :disabled="!text.trim() || sending"
          :aria-label="isEditing ? 'Confirm edit' : 'Send message'"
          @click="handleSend"
        >
          <svg v-if="sending" class="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" viewBox="0 0 24 24" />
          <svg
            v-else-if="isEditing"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <svg
            v-else
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>

        <!-- Mic button (shown when input is empty) — wrapped in a single-root <div>
             so transition can properly attach leave/enter hooks. VoiceRecorder has
             multiple root elements (v-if/v-else chain) which breaks out-in mode. -->
        <div v-else key="mic" class="inline-flex">
          <VoiceRecorder
            :state="voiceRecorder.state.value"
            :duration="voiceRecorder.duration.value"
            :waveform-data="voiceRecorder.waveformData.value"
            :recorded-blob="voiceRecorder.recordedBlob.value"
            @start="voiceRecorder.startRecording()"
            @start-locked="voiceRecorder.startAndLock()"
            @stop-and-send="handleVoiceSend"
            @stop-and-preview="voiceRecorder.stopAndPreview()"
            @send-preview="handleVoicePreviewSend"
            @lock="voiceRecorder.lock()"
            @cancel="voiceRecorder.cancel()"
          />
        </div>
      </transition>
    </div>

    <EmojiPicker
      :show="showEmojiPicker"
      :x="emojiPickerPos.x"
      :y="emojiPickerPos.y"
      mode="input"
      @close="showEmojiPicker = false"
      @select="insertEmoji"
      @select-gif="handleGifSelect"
      @select-kitchen="handleKitchenSelect"
    />

    <AttachmentPanel
      :show="showAttachmentPanel"
      :x="attachmentPanelPos.x"
      :y="attachmentPanelPos.y"
      :show-donate="props.showDonate"
      @close="showAttachmentPanel = false"
      @select-photo="openPhotoPicker"
      @select-file="openFilePicker"
      @select-poll="showPollCreator = true"
      @select-donate="emit('donate')"
    />

    <!-- Poll creator -->
    <PollCreator
      v-if="showPollCreator"
      @create="handleCreatePoll"
      @close="showPollCreator = false"
    />

    <MediaPreview
      :show="mediaUpload.files.value.length > 0"
      :files="mediaUpload.files.value"
      :active-index="mediaUpload.activeIndex.value"
      :caption="mediaUpload.caption.value"
      :caption-above="mediaUpload.captionAbove.value"
      :sending="mediaUpload.sending.value"
      @close="mediaUpload.clear()"
      @send="handleMediaSend"
      @update:active-index="mediaUpload.activeIndex.value = $event"
      @update:caption="mediaUpload.caption.value = $event"
      @update:caption-above="mediaUpload.captionAbove.value = $event"
      @remove-file="mediaUpload.removeFile($event)"
    />
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: no-preference) {
  .send-btn:active {
    animation: send-pulse 0.15s ease;
  }
}
@keyframes send-pulse {
  0% { transform: scale(1); }
  50% { transform: scale(0.9); }
  100% { transform: scale(1); }
}
.input-bar-enter-active,
.input-bar-leave-active {
  transition: max-height 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}
.input-bar-enter-from,
.input-bar-leave-to {
  max-height: 0;
  opacity: 0;
}
.input-bar-enter-to,
.input-bar-leave-from {
  max-height: 80px;
  opacity: 1;
}

/* Send/mic button morph */
.btn-morph-enter-active {
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.15s ease;
}
.btn-morph-leave-active {
  transition: transform 0.1s ease-in, opacity 0.1s ease-in;
}
.btn-morph-enter-from {
  opacity: 0;
  transform: scale(0.5);
}
.btn-morph-leave-to {
  opacity: 0;
  transform: scale(0.5);
}
</style>
