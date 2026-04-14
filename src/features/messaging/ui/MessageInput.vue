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
import { useVoiceRecorder } from "../model/use-voice-recorder";
import { useVideoCircleRecorder } from "../model/use-video-circle-recorder";
import { useMentionAutocomplete } from "../model/use-mention-autocomplete";
import MentionAutocomplete from "./MentionAutocomplete.vue";
import { useMobile } from "@/shared/lib/composables/use-media-query";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { shouldSendOnEnter } from "../model/enter-key-behavior";
import { isNative } from "@/shared/lib/platform";

const isMobile = useMobile();

const props = defineProps<{
  showDonate?: boolean;
}>();

const emit = defineEmits<{ donate: [] }>();

const chatStore = useChatStore();
const themeStore = useThemeStore();
const { t } = useI18n();
const { sendMessage, sendFile, sendImage, sendAudio, sendVideoCircle, sendReply, sendForward, editMessage, setTyping, sendPoll, sendGif } = useMessages();
const mediaUpload = useMediaUpload();
const pasteDrop = usePasteDrop({
  onMediaFiles: (files) => mediaUpload.addFiles(files),
  onOtherFiles: async (files) => {
    sending.value = true;
    try { for (const file of files) await sendFile(file); }
    finally { sending.value = false; }
  },
});
const voiceRecorder = useVoiceRecorder();
const videoRecorder = useVideoCircleRecorder();
const isVideoMode = ref(false);

const text = ref("");
const linkPreview = useLinkPreview(text);
const textareaRef = ref<HTMLTextAreaElement>();
const mention = useMentionAutocomplete(text, textareaRef);
const fileInputRef = ref<HTMLInputElement>();
const sending = ref(false);
let typingTimeout: ReturnType<typeof setTimeout> | null = null;
let lastTypingSent = 0;
const TYPING_THROTTLE_MS = 3000;

// --- Drafts ---
let draftTimer: ReturnType<typeof setTimeout> | undefined;
watch(text, (val) => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const roomId = chatStore.activeRoomId;
    if (roomId) saveDraft(roomId, val);
  }, 500);
});

watch(
  () => chatStore.activeRoomId,
  (newId, oldId) => {
    if (oldId) {
      saveDraft(oldId, text.value);
      // Don't save forward back to the source room — forward travels to target only
      const fwd = chatStore.forwardingMessage;
      if (fwd && fwd.roomId !== oldId) {
        chatStore.saveForwardDraft(oldId);
      }
    }
    text.value = newId ? getDraft(newId) : "";
    mention.clearMentions();
    chatStore.editingMessage = null;
    chatStore.replyingTo = null;
    if (newId) chatStore.restoreForwardDraft(newId);
    else chatStore.forwardingMessage = null;
    nextTick(() => { if (textareaRef.value) textareaRef.value.style.height = "auto"; });
  },
  { immediate: true }
);

const saveDraftOnBlur = () => {
  const roomId = chatStore.activeRoomId;
  if (roomId) saveDraft(roomId, text.value);
};

onBeforeUnmount(() => {
  const roomId = chatStore.activeRoomId;
  if (roomId) saveDraft(roomId, text.value);
  // Clean up any lingering recording mouse/move listeners
  document.removeEventListener("mouseup", handleGlobalMouseUp);
  document.removeEventListener("mousemove", handleGlobalMouseMove);
});

// --- Edit/reply ---
watch(() => chatStore.editingMessage, (editing) => {
  if (editing) {
    text.value = editing.content;
    nextTick(() => {
      autoGrowSync();
      textareaRef.value?.focus();
      // Scroll input container into view after keyboard settles (~400ms).
      // Uses block:"end" to keep input at bottom, not center.
      setTimeout(() => {
        inputRootRef.value?.scrollIntoView({ block: "end", behavior: "smooth" });
      }, 400);
    });
  }
}, { immediate: true });

watch(() => chatStore.replyingTo, (reply) => {
  if (reply) nextTick(() => textareaRef.value?.focus());
});

watch(() => chatStore.forwardingMessage, (fwd) => {
  if (fwd) nextTick(() => textareaRef.value?.focus());
});

const peerKeysOk = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return true;
  const status = chatStore.peerKeysStatus.get(roomId);
  // Block send only when peers are missing keys in a private room.
  // "not-encrypted" rooms (public / large) allow plain-text send.
  return status !== "missing";
});

const isEditing = computed(() => !!chatStore.editingMessage);

const cancelEdit = () => {
  chatStore.editingMessage = null;
  const roomId = chatStore.activeRoomId;
  text.value = roomId ? getDraft(roomId) : "";
  nextTick(() => { if (textareaRef.value) textareaRef.value.style.height = "auto"; });
};

const maxTextareaHeight = computed(() => isMobile.value ? 120 : 200);

let resizeRaf = 0;
const autoGrow = () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    const el = textareaRef.value;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, maxTextareaHeight.value) + "px";
  });
};

// Synchronous version for cases where we need immediate resize (edit mode, room switch)
const autoGrowSync = () => {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, maxTextareaHeight.value) + "px";
};

// Keep old name as alias so existing callsites work
const autoResize = autoGrow;

const showSecondaryActions = computed(() => !isMobile.value || !text.value.trim());

const handleSend = async () => {
  if ((!text.value.trim() && !showForwardPreview.value) || !peerKeysOk.value) return;
  const rawText = mention.resolveText();
  const savedText = text.value;

  // Clear input optimistically — restore if send completely fails before UI insert
  text.value = "";
  mention.clearMentions();
  const roomId = chatStore.activeRoomId;
  if (roomId) clearDraft(roomId);
  setTyping(false);
  nextTick(() => { if (textareaRef.value) textareaRef.value.style.height = "auto"; });

  let inserted: boolean | undefined;
  try {
    if (isEditing.value) {
      editMessage(chatStore.editingMessage!.id, rawText);
      chatStore.editingMessage = null;
      inserted = true;
    } else if (chatStore.forwardingMessage) {
      const fwd = chatStore.forwardingMessage;

      // External share with file: send file directly instead of text forward
      if (fwd.isExternalShare && fwd.fileInfo?.url) {
        try {
          const response = await fetch(fwd.fileInfo.url);
          const blob = await response.blob();
          const fileName = fwd.fileInfo.name || "shared_file";
          const file = new File([blob], fileName, { type: fwd.fileInfo.type || blob.type });

          if (fwd.type === MessageType.image) {
            inserted = await sendImage(file);
          } else {
            inserted = await sendFile(file);
          }
        } catch (e) {
          console.error("[MessageInput] Failed to send external share file:", e);
          inserted = false;
        }
        if (inserted !== false) chatStore.cancelForward();
      } else {
        const forwardMeta = fwd.withSenderInfo
          ? { senderId: fwd.senderId, senderName: fwd.senderName }
          : undefined;
        const forwardContent = rawText || fwd.content || forwardPreviewText.value;
        inserted = await sendForward(forwardContent, forwardMeta);
        if (inserted !== false) chatStore.cancelForward();
      }
    } else if (chatStore.replyingTo) {
      inserted = await sendReply(rawText, linkPreview.dismissed.value);
    } else {
      inserted = await sendMessage(rawText, linkPreview.dismissed.value);
    }
  } catch (e) {
    console.error("[handleSend] Unexpected error:", e);
    inserted = false;
  }

  // If message was NOT inserted into UI at all, restore the text so the user doesn't lose it
  if (inserted === false) {
    text.value = savedText;
    if (roomId) saveDraft(roomId, savedText);
    nextTick(() => autoGrow());
  }
};

const handleKeydown = (e: KeyboardEvent) => {
  if (mention.handleKeydown(e)) return;

  if (shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.isComposing, isMobile: isMobile.value, isNative })) {
    e.preventDefault();
    handleSend();
  }
};

const handleInput = () => {
  // On mobile IME keyboards, Vue 3 v-model delays updating the ref until
  // compositionend. Sync from DOM immediately so the send button appears.
  const el = textareaRef.value;
  if (el && el.value !== text.value) {
    text.value = el.value;
  }
  autoResize();
  mention.onCursorChange();

  // Throttle typing indicator: send at most once per TYPING_THROTTLE_MS
  const now = Date.now();
  if (now - lastTypingSent >= TYPING_THROTTLE_MS) {
    lastTypingSent = now;
    setTyping(true);
  }
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { setTyping(false); lastTypingSent = 0; }, 5000);
};

// --- Attachment/polls ---
const showAttachmentPanel = ref(false);
const showPollCreator = ref(false);
const handleCreatePoll = (question: string, options: string[]) => { showPollCreator.value = false; sendPoll(question, options); };
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

const openFilePicker = () => { fileInputRef.value?.click(); };
const openPhotoPicker = () => { photoInputRef.value?.click(); };

const handlePhotoSelect = (e: Event) => {
  const target = e.target as HTMLInputElement;
  if (!target.files?.length) return;
  mediaUpload.addFiles(target.files);
  target.value = "";
};

const handleFileSelect = async (e: Event) => {
  const target = e.target as HTMLInputElement;
  if (!target.files?.length) return;
  sending.value = true;
  try { for (const file of Array.from(target.files)) await sendFile(file); }
  finally { sending.value = false; target.value = ""; }
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
        ? { caption: mediaUpload.caption.value, captionAbove: mediaUpload.captionAbove.value } : {};
      if (f.type === "image") await sendImage(f.file, captionOpts);
      else await sendFile(f.file);
    }
  } finally { mediaUpload.clear(); }
};

const cancelReply = () => { chatStore.replyingTo = null; };

const replyInputPreviewText = computed(() => {
  const reply = chatStore.replyingTo;
  if (!reply) return "";
  if (reply.type === MessageType.image) return "Photo";
  if (reply.type === MessageType.video) return "Video";
  if (reply.type === MessageType.videoCircle) return "Video message";
  if (reply.type === MessageType.audio) return "Voice message";
  if (reply.type === MessageType.file) return reply.content || "File";
  const t = stripBastyonLinks(stripMentionAddresses(reply.content));
  return (t.length > 100 ? t.slice(0, 100) + "\u2026" : t) || "...";
});

/** Show forward preview only after user picked a target (not while still in source room with picker open) */
const showForwardPreview = computed(() => {
  const fwd = chatStore.forwardingMessage;
  if (!fwd) return false;
  // Hide in source room — preview only shows in the target room
  return chatStore.activeRoomId !== fwd.roomId;
});

const forwardPreviewText = computed(() => {
  const fwd = chatStore.forwardingMessage;
  if (!fwd) return "";
  if (fwd.type === MessageType.image) return "Photo";
  if (fwd.type === MessageType.video) return "Video";
  if (fwd.type === MessageType.videoCircle) return "Video message";
  if (fwd.type === MessageType.audio) return "Voice message";
  if (fwd.type === MessageType.file) return fwd.content || "File";
  const txt = stripBastyonLinks(stripMentionAddresses(fwd.content));
  return (txt.length > 100 ? txt.slice(0, 100) + "\u2026" : txt) || "...";
});

// Forward cancel confirmation
const { resolve: resolveRoomName } = useResolvedRoomName();
const forwardSourceRoomName = computed(() => {
  const fwd = chatStore.forwardingMessage;
  if (!fwd) return "";
  const room = chatStore.rooms.find(r => r.id === fwd.roomId);
  return room ? resolveRoomName(room) : "";
});
const showCancelForwardConfirm = ref(false);

const cancelForward = () => {
  showCancelForwardConfirm.value = true;
};

const confirmCancelForward = () => {
  showCancelForwardConfirm.value = false;
  chatStore.cancelForward();
};

const dismissCancelForward = () => {
  showCancelForwardConfirm.value = false;
};

// Forward options popup
const showForwardOptions = ref(false);

const openForwardOptions = () => {
  showForwardOptions.value = !showForwardOptions.value;
};

// Close forward options on click outside
const onDocumentClick = (e: MouseEvent) => {
  if (showForwardOptions.value) {
    showForwardOptions.value = false;
  }
};
watch(showForwardOptions, (v) => {
  if (v) setTimeout(() => document.addEventListener("click", onDocumentClick, { once: true }), 0);
});

const toggleSenderInfo = () => {
  if (chatStore.forwardingMessage) {
    chatStore.forwardingMessage.withSenderInfo = !chatStore.forwardingMessage.withSenderInfo;
  }
};

const changeForwardTarget = () => {
  showForwardOptions.value = false;
  chatStore.forwardPickerRequested = true;
};

// --- Recording handlers ---
const handleVoiceSend = async () => {
  const result = await voiceRecorder.stopAndSend();
  if (result) await sendAudio(result.file, { duration: result.duration, waveform: result.waveform });
};
const handleVoicePreviewSend = async () => {
  const result = await voiceRecorder.sendPreview();
  if (result) await sendAudio(result.file, { duration: result.duration, waveform: result.waveform });
};
const handleVideoCircleSend = async () => {
  const result = await videoRecorder.stopAndSend();
  if (result) await sendVideoCircle(result.file, { duration: result.duration });
};
const handleVideoCirclePreviewSend = async () => {
  const result = await videoRecorder.sendPreview();
  if (result) await sendVideoCircle(result.file, { duration: result.duration });
};

// --- Unified record state ---
type RecState = "idle" | "recording" | "locked" | "preview";
const recState = computed<RecState>(() => {
  const vs = voiceRecorder.state.value;
  const vds = videoRecorder.state.value;
  if (vs === "recording" || vds === "recording") return "recording";
  if (vs === "locked" || vds === "locked") return "locked";
  if (vs === "preview" || vds === "preview") return "preview";
  return "idle";
});

const recDuration = computed(() =>
  isVideoMode.value ? videoRecorder.duration.value : voiceRecorder.duration.value
);

const formatDuration = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

// Waveform for voice
const waveformBars = computed(() => {
  const data = voiceRecorder.waveformData.value;
  if (data.length === 0) return Array(30).fill(0.05);
  const last = data.slice(-30);
  while (last.length < 30) last.unshift(0.05);
  return last;
});

// Voice preview playback
const previewAudio = ref<HTMLAudioElement | null>(null);
const isPreviewPlaying = ref(false);

watch(() => voiceRecorder.recordedBlob.value, (blob) => {
  if (blob) {
    previewAudio.value = new Audio(URL.createObjectURL(blob));
    previewAudio.value.onended = () => { isPreviewPlaying.value = false; };
  } else {
    previewAudio.value = null;
    isPreviewPlaying.value = false;
  }
});

const togglePreviewPlay = () => {
  if (!previewAudio.value) return;
  if (isPreviewPlaying.value) { previewAudio.value.pause(); isPreviewPlaying.value = false; }
  else { previewAudio.value.play(); isPreviewPlaying.value = true; }
};

// Video preview
const videoPreviewUrl = ref<string | null>(null);
watch(() => videoRecorder.recordedBlob.value, (blob) => {
  if (videoPreviewUrl.value) { URL.revokeObjectURL(videoPreviewUrl.value); videoPreviewUrl.value = null; }
  if (blob) videoPreviewUrl.value = URL.createObjectURL(blob);
});
onBeforeUnmount(() => { if (videoPreviewUrl.value) URL.revokeObjectURL(videoPreviewUrl.value); });

// --- Telegram-style hold = record, tap = toggle ---
const HOLD_THRESHOLD = 250;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let isHolding = false;
const touchStartY = ref(0);
const touchStartX = ref(0);
const isCancelling = ref(false);
let isLocked = false;
const recHint = ref<string | null>(null);
let recHintTimer: ReturnType<typeof setTimeout> | null = null;

const showRecHint = () => {
  if (recHintTimer) clearTimeout(recHintTimer);
  recHint.value = isVideoMode.value
    ? t("voice.hintAudio")
    : t("voice.hintVideo");
  recHintTimer = setTimeout(() => { recHint.value = null; }, 2000);
};

const clearHoldTimer = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

const startRec = () => {
  if (isVideoMode.value) videoRecorder.startRecording();
  else voiceRecorder.startRecording();
};

const lockRec = () => {
  if (isVideoMode.value) videoRecorder.lock();
  else voiceRecorder.lock();
};

const cancelRec = () => {
  if (isVideoMode.value) videoRecorder.cancel();
  else voiceRecorder.cancel();
};

const sendRec = () => {
  if (isVideoMode.value) handleVideoCircleSend();
  else handleVoiceSend();
};

// Touch
const handleRecordTouchStart = (e: TouchEvent) => {
  isHolding = false;
  isLocked = false;
  isCancelling.value = false;
  touchStartY.value = e.touches[0].clientY;
  touchStartX.value = e.touches[0].clientX;
  holdTimer = setTimeout(() => { isHolding = true; startRec(); }, HOLD_THRESHOLD);
};

const handleRecordTouchMove = (e: TouchEvent) => {
  if (!isHolding) return;
  const dy = touchStartY.value - e.touches[0].clientY;
  const dx = touchStartX.value - e.touches[0].clientX;
  if (dy > 80) { isLocked = true; lockRec(); return; }
  if (dx > 130) isCancelling.value = true;
};

const handleRecordTouchEnd = () => {
  clearHoldTimer();
  if (!isHolding) { isVideoMode.value = !isVideoMode.value; showRecHint(); return; }
  isHolding = false;
  if (isLocked) { isLocked = false; return; }
  if (isCancelling.value) { isCancelling.value = false; cancelRec(); return; }
  sendRec();
};

// Desktop: tap = toggle, hold = record, release = send, drag up = lock
const mouseStartY = ref(0);
const mouseStartX = ref(0);

const handleGlobalMouseMove = (e: MouseEvent) => {
  if (!isHolding) return;
  const dy = mouseStartY.value - e.clientY;
  const dx = mouseStartX.value - e.clientX;
  if (dy > 80) { isLocked = true; lockRec(); return; }
  if (dx > 130) isCancelling.value = true;
};

const handleGlobalMouseUp = () => {
  document.removeEventListener("mouseup", handleGlobalMouseUp);
  document.removeEventListener("mousemove", handleGlobalMouseMove);
  clearHoldTimer();
  if (!isHolding) { isVideoMode.value = !isVideoMode.value; showRecHint(); return; }
  isHolding = false;
  if (isLocked) { isLocked = false; return; }
  if (isCancelling.value) { isCancelling.value = false; cancelRec(); return; }
  sendRec();
};

const handleRecordMouseDown = (e: MouseEvent) => {
  isHolding = false;
  isLocked = false;
  isCancelling.value = false;
  mouseStartY.value = e.clientY;
  mouseStartX.value = e.clientX;
  document.addEventListener("mouseup", handleGlobalMouseUp, { once: true });
  document.addEventListener("mousemove", handleGlobalMouseMove);
  holdTimer = setTimeout(() => {
    isHolding = true;
    startRec();
  }, HOLD_THRESHOLD);
};

// Root ref for overlay positioning
const inputRootRef = ref<HTMLElement | null>(null);

// Video circle overlay
const overlayVideoRef = ref<HTMLVideoElement | null>(null);
watch(() => videoRecorder.videoStream.value, (stream) => {
  if (overlayVideoRef.value) overlayVideoRef.value.srcObject = stream;
});
watch(overlayVideoRef, (el) => {
  if (el && videoRecorder.videoStream.value) el.srcObject = videoRecorder.videoStream.value;
});

// --- Misc ---
const showEmojiPicker = ref(false);
const emojiPickerPos = ref({ x: 0, y: 0 });

defineExpose({
  addMediaFiles: (files: File[]) => mediaUpload.addFiles(files),
  sendOtherFiles: async (files: File[]) => {
    sending.value = true;
    try { for (const file of files) await sendFile(file); }
    finally { sending.value = false; }
  },
});

const insertEmoji = (emoji: string) => {
  const el = textareaRef.value;
  if (el) {
    const start = el.selectionStart ?? text.value.length;
    const end = el.selectionEnd ?? text.value.length;
    text.value = text.value.slice(0, start) + emoji + text.value.slice(end);
    nextTick(() => { el.selectionStart = el.selectionEnd = start + emoji.length; el.focus(); autoResize(); });
  } else { text.value += emoji; }
  themeStore.addRecentEmoji(emoji);
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
  } catch (e) { console.error("Failed to send kitchen emoji:", e); }
};
</script>

<template>
  <div ref="inputRootRef" class="relative border-t border-neutral-grad-0 bg-background-total-theme">
    <!-- Editing bar -->
    <div class="input-bar-grid" :class="{ 'input-bar-grid--open': isEditing }">
      <div class="input-bar-grid-inner">
        <div class="mx-auto flex max-w-6xl items-center gap-2 border-b border-neutral-grad-0 px-3 py-2">
          <div class="flex h-8 w-8 items-center justify-center text-color-bg-ac">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-xs font-medium text-color-bg-ac">{{ t("message.editing") }}</div>
            <div class="truncate text-xs text-text-on-main-bg-color">{{ chatStore.editingMessage?.content }}</div>
          </div>
          <button class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0" @click="cancelEdit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Reply preview bar -->
    <div class="input-bar-grid" :class="{ 'input-bar-grid--open': !isEditing && chatStore.replyingTo }">
      <div class="input-bar-grid-inner">
        <div class="mx-auto flex max-w-6xl items-center gap-2 border-b border-neutral-grad-0 px-3 py-2">
          <div class="h-8 w-0.5 shrink-0 rounded-full bg-color-bg-ac" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-xs font-medium text-color-bg-ac">{{ chatStore.getDisplayName(chatStore.replyingTo?.senderId ?? '') }}</div>
            <div class="truncate text-xs text-text-on-main-bg-color">{{ replyInputPreviewText }}</div>
          </div>
          <button class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0" @click="cancelReply">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Forward preview bar -->
    <div class="input-bar-grid" :class="{ 'input-bar-grid--open': !isEditing && !chatStore.replyingTo && showForwardPreview }">
      <div class="input-bar-grid-inner">
        <div class="relative mx-auto flex max-w-6xl items-center gap-2 border-b border-neutral-grad-0 px-3 py-2">
          <button class="flex h-8 w-8 items-center justify-center text-color-bg-ac" @click="openForwardOptions">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 17 20 12 15 7" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" />
            </svg>
          </button>
          <div class="h-8 w-0.5 shrink-0 rounded-full bg-color-bg-ac" />
          <div class="min-w-0 flex-1 cursor-pointer" @click="openForwardOptions">
            <div class="truncate text-xs font-medium text-color-bg-ac">
              {{ chatStore.forwardingMessage?.withSenderInfo ? (chatStore.forwardingMessage?.senderName || t("forward.message")) : t("forward.message") }}
            </div>
            <div class="truncate text-xs text-text-on-main-bg-color">{{ forwardPreviewText }}</div>
          </div>
          <button class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0" @click="cancelForward">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>

        </div>
      </div>
    </div>

    <!-- Forward options popup (outside grid to avoid overflow:hidden clipping) -->
    <div v-if="showForwardPreview" class="relative">
      <div class="absolute bottom-full left-2 z-50 mb-1" :class="showForwardOptions ? 'visible opacity-100' : 'invisible opacity-0'" style="transition: opacity 0.2s ease, visibility 0.2s ease;">
        <div class="min-w-[220px] rounded-xl bg-background-total-theme py-1 shadow-lg ring-1 ring-neutral-grad-0">
          <button
            class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-text-color transition-colors hover:bg-neutral-grad-0"
            @click="toggleSenderInfo"
          >
            <svg v-if="chatStore.forwardingMessage?.withSenderInfo" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="text-color-bg-ac"><polyline points="20 6 9 17 4 12" /></svg>
            <span v-else class="inline-block h-4 w-4" />
            {{ t("forward.showSender") }}
          </button>
          <button
            class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-text-color transition-colors hover:bg-neutral-grad-0"
            @click="toggleSenderInfo"
          >
            <svg v-if="!chatStore.forwardingMessage?.withSenderInfo" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="text-color-bg-ac"><polyline points="20 6 9 17 4 12" /></svg>
            <span v-else class="inline-block h-4 w-4" />
            {{ t("forward.hideSender") }}
          </button>
          <div class="my-1 border-t border-neutral-grad-0" />
          <button
            class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-text-color transition-colors hover:bg-neutral-grad-0"
            @click="changeForwardTarget"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" />
            </svg>
            {{ t("forward.changeChat") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Forward cancel confirmation modal -->
    <Teleport to="body">
      <transition name="fp-fade">
        <div
          v-if="showCancelForwardConfirm"
          class="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          @click.self="dismissCancelForward"
        >
          <div class="mx-4 w-full max-w-sm rounded-2xl bg-background-total-theme p-5 shadow-xl">
            <div class="mb-1 text-center text-base font-semibold text-text-color">{{ t("forward.cancelConfirm.title") }}</div>
            <div class="mb-5 text-center text-sm text-text-on-main-bg-color">
              {{ t("forward.cancelConfirm.description", { name: forwardSourceRoomName }) }}
            </div>
            <div class="flex flex-col gap-2">
              <button
                class="w-full rounded-xl bg-neutral-grad-0 py-3 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-1"
                @click="dismissCancelForward(); openForwardOptions()"
              >
                {{ t("forward.cancelConfirm.settings") }}
              </button>
              <button
                class="w-full rounded-xl bg-red-500 py-3 text-sm font-medium text-white transition-colors hover:bg-red-600"
                @click="confirmCancelForward"
              >
                {{ t("forward.cancelConfirm.cancel") }}
              </button>
            </div>
          </div>
        </div>
      </transition>
    </Teleport>

    <!-- Link preview bar -->
    <div class="input-bar-grid" :class="{ 'input-bar-grid--open': !isEditing && !chatStore.replyingTo && (linkPreview.loading.value || linkPreview.activePreview.value) }">
      <div class="input-bar-grid-inner">
        <div class="mx-auto flex max-w-6xl items-center gap-2 border-b border-neutral-grad-0 px-3 py-2">
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
            <div class="truncate text-xs font-medium text-text-on-main-bg-color/60">{{ linkPreview.activePreview.value.siteName || linkPreview.activePreview.value.title || 'Link' }}</div>
            <div class="truncate text-xs text-text-on-main-bg-color/40">{{ linkPreview.activePreview.value.description || linkPreview.activePreview.value.title || linkPreview.activePreview.value.url }}</div>
          </template>
        </div>
        <button class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0" @click="linkPreview.dismiss()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
        </button>
        </div>
      </div>
    </div>

    <!-- === MAIN INPUT ROW — always same height/width, content changes by state === -->
    <div class="relative mx-auto flex max-w-6xl items-center gap-1.5 px-2 py-2">
      <!-- Mention autocomplete -->
      <MentionAutocomplete
        v-if="recState === 'idle' && mention.active.value && mention.filteredMembers.value.length > 0 && chatStore.activeRoom?.isGroup"
        :members="mention.filteredMembers.value"
        :selected-index="mention.selectedIndex.value"
        @select="mention.insertMention"
      />
      <!-- Hidden file inputs -->
      <input ref="photoInputRef" type="file" class="hidden" multiple accept="image/*,video/*" @change="handlePhotoSelect" />
      <input ref="fileInputRef" type="file" class="hidden" multiple @change="handleFileSelect" />

      <!-- ======= IDLE state: normal input ======= -->
      <template v-if="recState === 'idle'">
        <!-- Emoji button -->
        <button
          class="btn-press flex h-10 w-10 min-h-tap min-w-tap shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color/60 transition-colors hover:text-text-on-main-bg-color"
          :title="t('message.emoji')"
          @click="(e: MouseEvent) => { const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); emojiPickerPos = { x: rect.left, y: rect.top }; showEmojiPicker = !showEmojiPicker; }"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" />
          </svg>
        </button>

        <!-- Textarea -->
        <textarea
          ref="textareaRef" v-model="text" :placeholder="t('message.placeholder')" rows="1"
          class="flex-1 resize-none rounded-2xl bg-chat-input-bg px-4 py-2.5 text-base leading-[24px] text-text-color outline-none transition-shadow duration-200 placeholder:text-neutral-grad-2 focus:ring-2 focus:ring-color-bg-ac/30"
          :style="{ maxHeight: maxTextareaHeight + 'px', fontSize: '16px' }"
          :disabled="sending" data-keyboard-aware
          @keydown="handleKeydown" @input="handleInput" @blur="saveDraftOnBlur"
          @compositionupdate="handleInput" @compositionend="handleInput"
          @paste="pasteDrop.handlePaste" @click="mention.onCursorChange()"
        />

        <!-- PKOIN button -->
        <transition name="btn-morph">
          <button v-if="props.showDonate && showSecondaryActions"
            class="btn-press flex h-10 w-10 min-h-tap min-w-tap shrink-0 items-center justify-center rounded-full text-color-txt-ac/60 transition-colors hover:text-color-txt-ac"
            :disabled="sending" :title="t('wallet.sendPkoin')" @click="emit('donate')">
            <svg width="20" height="20" viewBox="0 0 18 18" fill="currentColor">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M17.2584 1.97869L15.182 0L12.7245 2.57886C11.5308 1.85218 10.1288 1.43362 8.62907 1.43362C7.32722 1.43362 6.09904 1.74902 5.01676 2.30756L2.81787 6.45386e-05L0.741455 1.97875L2.73903 4.07498C1.49651 5.46899 0.741455 7.30694 0.741455 9.32124C0.741455 11.1753 1.38114 12.8799 2.45184 14.2264L0.741455 16.0213L2.81787 18L4.61598 16.1131C5.79166 16.8092 7.1637 17.2088 8.62907 17.2088C10.2903 17.2088 11.8317 16.6953 13.1029 15.8182L15.182 18L17.2584 16.0213L15.1306 13.7884C16.0049 12.5184 16.5167 10.9796 16.5167 9.32124C16.5167 7.50123 15.9003 5.8252 14.8648 4.49052L17.2584 1.97869ZM3.5551 9.32124C3.5551 12.1235 5.82679 14.3952 8.62907 14.3952C11.4313 14.3952 13.703 12.1235 13.703 9.32124C13.703 6.51896 11.4313 4.24727 8.62907 4.24727C5.82679 4.24727 3.5551 6.51896 3.5551 9.32124Z" />
            </svg>
          </button>
        </transition>

        <!-- Attach button -->
        <transition name="btn-morph">
          <button v-if="showSecondaryActions" ref="attachBtnRef"
            class="btn-press flex h-10 w-10 min-h-tap min-w-tap shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color/60 transition-colors hover:text-text-on-main-bg-color"
            :disabled="sending" :title="t('message.attach')" @click="toggleAttachmentPanel">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
        </transition>

        <!-- Send OR record button -->
        <transition name="btn-morph" mode="out-in">
          <button v-if="text.trim() || sending || showForwardPreview" key="send"
            class="send-btn flex h-10 w-10 min-h-tap min-w-tap shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-white transition-all hover:bg-color-bg-ac-1 disabled:opacity-50"
            :disabled="(!text.trim() && !showForwardPreview) || sending || !peerKeysOk" @click="handleSend">
            <svg v-if="sending" class="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" viewBox="0 0 24 24" />
            <svg v-else-if="isEditing" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12" /></svg>
            <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
          </button>

          <!-- Record button: tap = toggle mic/camera, hold = record -->
          <div v-else key="rec" class="relative shrink-0">
            <!-- Hint tooltip above button -->
            <transition name="circle-fade">
              <div v-if="recHint" class="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-neutral-grad-0 px-3 py-1.5 text-xs text-text-color shadow-lg">
                {{ recHint }}
                <div class="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-neutral-grad-0" />
              </div>
            </transition>
            <button
              class="rec-btn flex h-10 w-10 min-h-tap min-w-tap items-center justify-center rounded-full text-text-on-main-bg-color/60 transition-colors hover:text-text-on-main-bg-color"
              @touchstart.prevent="handleRecordTouchStart" @touchmove="handleRecordTouchMove" @touchend="handleRecordTouchEnd"
              @mousedown.prevent="handleRecordMouseDown">
              <transition name="mode-icon" mode="out-in">
                <svg v-if="isVideoMode" key="cam" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
                <svg v-else key="mic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </transition>
            </button>
          </div>
        </transition>
      </template>

      <!-- ======= RECORDING state (mobile hold-to-record) ======= -->
      <template v-else-if="recState === 'recording'">
        <span class="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-color-bad" />
        <span class="shrink-0 text-sm tabular-nums font-medium text-text-color">{{ formatDuration(recDuration) }}</span>
        <span class="flex-1 text-center text-sm text-text-on-main-bg-color/50">{{ t('voice.slideCancel') }}</span>
        <!-- Record button + lock pill above -->
        <div class="relative shrink-0">
          <!-- Lock pill floating above button, centered -->
          <div class="absolute bottom-full left-0 right-0 z-50 mb-2 flex justify-center animate-bounce">
            <div class="flex flex-col items-center gap-0.5 rounded-full bg-color-bg-ac/20 px-2.5 py-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-bg-ac))" stroke-width="2.5">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-bg-ac))" stroke-width="3">
                <path d="M18 15l-6-6-6 6" />
              </svg>
            </div>
          </div>
          <!-- Big record circle (same style as idle but pulsing) -->
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-color-bg-ac text-white shadow-lg animate-pulse">
            <svg v-if="isVideoMode" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </div>
        </div>
      </template>

      <!-- ======= LOCKED state (hands-free recording) — Telegram style ======= -->
      <template v-else-if="recState === 'locked'">
        <span class="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-color-bad" />
        <span class="shrink-0 text-sm tabular-nums font-medium text-text-color">{{ formatDuration(recDuration) }}</span>
        <!-- Cancel text in center -->
        <button class="flex-1 text-center text-sm text-text-on-main-bg-color/60 transition-colors hover:text-color-bad" @click="cancelRec">
          {{ t('voice.cancel') }}
        </button>
        <!-- Stop/preview button floating above send -->
        <div class="relative shrink-0">
          <div class="absolute bottom-full left-0 right-0 z-50 mb-2 flex justify-center">
            <button class="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-grad-0 text-text-color shadow-md transition-colors hover:bg-neutral-grad-1"
              :title="t('voice.stopAndPreview')"
              @click="isVideoMode ? videoRecorder.stopAndPreview() : voiceRecorder.stopAndPreview()">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
            </button>
          </div>
          <!-- Send button — big circle -->
          <button class="flex h-12 w-12 items-center justify-center rounded-full bg-color-bg-ac text-white shadow-lg transition-all hover:brightness-110"
            title="Send" @click="isVideoMode ? handleVideoCircleSend() : handleVoiceSend()">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </template>

      <!-- ======= PREVIEW state ======= -->
      <template v-else-if="recState === 'preview'">
        <!-- Cancel button -->
        <button class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-color-bad transition-colors hover:bg-neutral-grad-0" @click="cancelRec">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
        <!-- Preview content -->
        <div class="flex h-[44px] flex-1 items-center gap-2 rounded-2xl bg-chat-input-bg px-4">
          <!-- Voice: play button + timer -->
          <template v-if="!isVideoMode">
            <button class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac" @click="togglePreviewPlay">
              <svg v-if="!isPreviewPlaying" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
            </button>
            <span class="text-sm tabular-nums text-text-color">{{ formatDuration(recDuration) }}</span>
          </template>
          <!-- Video: small circle preview + timer -->
          <template v-else>
            <div class="h-8 w-8 shrink-0 overflow-hidden rounded-full">
              <video v-if="videoPreviewUrl" :src="videoPreviewUrl" loop autoplay muted playsinline class="h-full w-full object-cover" />
            </div>
            <span class="text-sm tabular-nums text-text-color">{{ formatDuration(recDuration) }}</span>
          </template>
        </div>
        <!-- Send button -->
        <button class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-white transition-all hover:brightness-110"
          @click="isVideoMode ? handleVideoCirclePreviewSend() : handleVoicePreviewSend()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
        </button>
      </template>
    </div>

    <!-- Video circle recording overlay — positioned ABOVE input, within chat area only -->
    <transition name="circle-fade">
      <div
        v-if="isVideoMode && (videoRecorder.state.value === 'recording' || videoRecorder.state.value === 'locked')"
        class="absolute bottom-full left-0 right-0 z-40 flex items-center justify-center backdrop-blur-md video-overlay-pos"
        style="background: rgba(0, 0, 0, 0.35);"
        @click.self="videoRecorder.state.value === 'locked' ? cancelRec() : undefined"
      >
        <div class="relative flex items-center justify-center" style="width: 250px; height: 250px;">
          <svg class="absolute inset-0" width="250" height="250" viewBox="0 0 250 250">
            <circle cx="125" cy="125" r="118" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="3.5" />
            <circle cx="125" cy="125" r="118" fill="none" stroke="rgb(var(--color-bg-ac))" stroke-width="3.5" stroke-linecap="round"
              :stroke-dasharray="2 * Math.PI * 118" :stroke-dashoffset="2 * Math.PI * 118 * (1 - Math.min(videoRecorder.duration.value / 60, 1))"
              transform="rotate(-90 125 125)" style="transition: stroke-dashoffset 0.3s ease;" />
          </svg>
          <div class="h-[228px] w-[228px] overflow-hidden rounded-full shadow-2xl">
            <video ref="overlayVideoRef" autoplay muted playsinline class="h-full w-full object-cover" style="transform: scaleX(-1);" />
          </div>
        </div>
      </div>
    </transition>

    <EmojiPicker :show="showEmojiPicker" :x="emojiPickerPos.x" :y="emojiPickerPos.y" mode="input"
      @close="showEmojiPicker = false" @select="insertEmoji" @select-gif="handleGifSelect" @select-kitchen="handleKitchenSelect" />

    <AttachmentPanel :show="showAttachmentPanel" :x="attachmentPanelPos.x" :y="attachmentPanelPos.y" :show-donate="props.showDonate"
      @close="showAttachmentPanel = false" @select-photo="openPhotoPicker" @select-file="openFilePicker"
      @select-poll="showPollCreator = true" @select-donate="emit('donate')" />

    <PollCreator v-if="showPollCreator" @create="handleCreatePoll" @close="showPollCreator = false" />

    <MediaPreview :show="mediaUpload.files.value.length > 0" :files="mediaUpload.files.value" :active-index="mediaUpload.activeIndex.value"
      :caption="mediaUpload.caption.value" :caption-above="mediaUpload.captionAbove.value" :sending="mediaUpload.sending.value"
      @close="mediaUpload.clear()" @send="handleMediaSend" @update:active-index="mediaUpload.activeIndex.value = $event"
      @update:caption="mediaUpload.caption.value = $event" @update:caption-above="mediaUpload.captionAbove.value = $event"
      @remove-file="mediaUpload.removeFile($event)" />
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: no-preference) {
  .send-btn:active { animation: send-pulse 0.15s ease; }
}
@keyframes send-pulse {
  0% { transform: scale(1); }
  50% { transform: scale(0.9); }
  100% { transform: scale(1); }
}
.fp-fade-enter-active { transition: opacity 0.25s ease-out; }
.fp-fade-leave-active { transition: opacity 0.2s ease-in; }
.fp-fade-enter-from, .fp-fade-leave-to { opacity: 0; }
.input-bar-grid {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.2s ease, opacity 0.2s ease;
  opacity: 0;
}
.input-bar-grid--open {
  grid-template-rows: 1fr;
  opacity: 1;
}
.input-bar-grid-inner {
  min-height: 0;
  overflow: hidden;
}

.btn-morph-enter-active { transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.15s ease; }
.btn-morph-leave-active { transition: transform 0.1s ease-in, opacity 0.1s ease-in; }
.btn-morph-enter-from { opacity: 0; transform: scale(0.5); }
.btn-morph-leave-to { opacity: 0; transform: scale(0.5); }

.mode-icon-enter-active { transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.15s ease; }
.mode-icon-leave-active { transition: transform 0.12s ease-in, opacity 0.12s ease-in; }
.mode-icon-enter-from { opacity: 0; transform: scale(0.3) rotate(-90deg); }
.mode-icon-leave-to { opacity: 0; transform: scale(0.3) rotate(90deg); }

.circle-fade-enter-active { transition: opacity 0.25s ease; }
.circle-fade-leave-active { transition: opacity 0.2s ease; }
.circle-fade-enter-from, .circle-fade-leave-to { opacity: 0; }

.video-overlay-pos {
  top: -100vh;
  top: -100dvh;
}
</style>
