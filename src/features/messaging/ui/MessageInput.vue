<script setup lang="ts">
import { ref, nextTick, watch, computed } from "vue";
import { useChatStore, MessageType } from "@/entities/chat";
import { useThemeStore } from "@/entities/theme";
import { stripMentionAddresses } from "@/shared/lib/message-format";
import { getDraft, saveDraft, clearDraft } from "@/shared/lib/drafts";
import { useMessages } from "../model/use-messages";
import { useMediaUpload } from "../model/use-media-upload";
import EmojiPicker from "./EmojiPicker.vue";
import AttachmentPanel from "./AttachmentPanel.vue";
import MediaPreview from "./MediaPreview.vue";
import VoiceRecorder from "./VoiceRecorder.vue";
import { useVoiceRecorder } from "../model/use-voice-recorder";
import { useMentionAutocomplete } from "../model/use-mention-autocomplete";
import MentionAutocomplete from "./MentionAutocomplete.vue";

const chatStore = useChatStore();
const themeStore = useThemeStore();
const { sendMessage, sendFile, sendImage, sendAudio, sendReply, editMessage, setTyping } = useMessages();
const mediaUpload = useMediaUpload();
const voiceRecorder = useVoiceRecorder();

const text = ref("");
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

// Save draft before switching rooms, restore draft for new room
watch(() => chatStore.activeRoomId, (newId, oldId) => {
  if (oldId) saveDraft(oldId, text.value);
  text.value = newId ? getDraft(newId) : "";
  mention.clearMentions();
  chatStore.editingMessage = null;
  chatStore.replyingTo = null;
  nextTick(() => {
    if (textareaRef.value) textareaRef.value.style.height = "auto";
  });
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

const isEditing = computed(() => !!chatStore.editingMessage);

const cancelEdit = () => {
  chatStore.editingMessage = null;
  text.value = "";
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
    sendReply(rawText);
  } else {
    sendMessage(rawText);
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
  const text = stripMentionAddresses(reply.content);
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
</script>

<template>
  <div class="border-t border-neutral-grad-0 bg-background-total-theme">
    <!-- Editing bar -->
    <transition name="input-bar">
      <div
        v-if="isEditing"
        class="flex items-center gap-2 border-b border-neutral-grad-0 px-3 py-2"
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
        class="flex items-center gap-2 border-b border-neutral-grad-0 px-3 py-2"
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
          @click="cancelReply"
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
    <div v-else class="relative flex items-end gap-1 px-2 py-2">
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
        title="Emoji"
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
        placeholder="Message"
        rows="1"
        class="flex-1 resize-none rounded-2xl bg-chat-input-bg px-4 py-2.5 text-base leading-[24px] text-text-color outline-none placeholder:text-neutral-grad-2"
        :disabled="sending"
        @keydown="handleKeydown"
        @input="handleInput"
        @click="mention.onCursorChange()"
        @keyup="mention.onCursorChange()"
      />

      <!-- Attachment button (right of textarea) -->
      <button
        ref="attachBtnRef"
        class="btn-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color/60 transition-colors hover:text-text-on-main-bg-color"
        :disabled="sending"
        title="Attach"
        @click="toggleAttachmentPanel"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>

      <!-- Send / Confirm edit button (morphs with mic) -->
      <transition name="btn-morph" mode="out-in">
        <button
          v-if="text.trim() || sending"
          key="send"
          class="send-btn flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-white transition-all hover:bg-color-bg-ac-1 disabled:opacity-50"
          :disabled="!text.trim() || sending"
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

        <!-- Mic button (shown when input is empty) -->
        <VoiceRecorder
          v-else
          key="mic"
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
      </transition>
    </div>

    <EmojiPicker
      :show="showEmojiPicker"
      :x="emojiPickerPos.x"
      :y="emojiPickerPos.y"
      mode="input"
      @close="showEmojiPicker = false"
      @select="insertEmoji"
    />

    <AttachmentPanel
      :show="showAttachmentPanel"
      :x="attachmentPanelPos.x"
      :y="attachmentPanelPos.y"
      @close="showAttachmentPanel = false"
      @select-photo="openPhotoPicker"
      @select-file="openFilePicker"
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
