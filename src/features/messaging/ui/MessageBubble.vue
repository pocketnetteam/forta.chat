<script setup lang="ts">
import type { Message } from "@/entities/chat";
import { useChatStore, MessageStatus, MessageType } from "@/entities/chat";
import { formatTime } from "@/shared/lib/format";
import { stripMentionAddresses, stripBastyonLinks } from "@/shared/lib/message-format";
import { useFileDownload } from "../model/use-file-download";
import { useBugReport } from "@/features/bug-report";
import { tRaw } from "@/shared/lib/i18n";
import { useToast } from "@/shared/lib/use-toast";
import { useVideoStatePreservation } from "@/shared/lib/composables/use-video-state-preservation";
import { formatVideoDuration, extractVideoFrameThumbnail } from "../model/video-thumbnail";
import {
  videoPlaybackErrorFromMediaError,
  VIDEO_LOAD_TIMEOUT_MS,
  type VideoPlaybackError,
} from "../model/video-error";
import MessageContent from "./MessageContent.vue";
import MessageStatusIcon from "./MessageStatusIcon.vue";
import PollCard from "./PollCard.vue";
import TransferCard from "./TransferCard.vue";
import ReactionRow from "./ReactionRow.vue";
import VoiceMessage from "./VoiceMessage.vue";
import VideoCirclePlayer from "./VideoCirclePlayer.vue";
import { ref, inject, onMounted, onBeforeUnmount } from "vue";
import { useLongPress, useSwipeGesture } from "@/shared/lib/gestures";
import { useThemeStore } from "@/entities/theme";
import { hexDecode } from "@/shared/lib/matrix/functions";
import { getUserDisplayNameForUI } from "@/entities/chat";

// Responsive max image width: clamp to ~78% of viewport on small screens
const viewportW = ref(typeof window !== "undefined" ? window.innerWidth : 800);
const onResizeBubble = () => { viewportW.value = window.innerWidth; };
onMounted(() => window.addEventListener("resize", onResizeBubble));
onBeforeUnmount(() => window.removeEventListener("resize", onResizeBubble));
const imageMaxW = computed(() => Math.min(420, Math.round(viewportW.value * 0.78)));

const { t } = useI18n();
const openUserProfile = inject<((address: string) => void) | null>("openUserProfile", null);

interface Props {
  message: Message;
  isOwn: boolean;
  showAvatar: boolean;
  isGroup?: boolean;
  isFirstInGroup?: boolean;
  myAddress?: string;
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
  delete: [message: Message];
  forward: [message: Message];
  resize: [];
  retryMedia: [message: Message];
  retryMessage: [message: Message];
  cancelUpload: [message: Message];
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

// Use direction "both" always — callbacks read live props to handle virtual scroller recycling
const { offsetX: swipeOffsetX, isSwiping, swipeDirection, onTouchstart, onTouchmove, onTouchend } = useSwipeGesture({
  direction: "both",
  threshold: 60,
  maxOffset: 100,
  onTriggerLeft: () => { emit("reply", props.message); },
  onTriggerRight: () => { /* reveal actions — handled via swipeDirection ref */ },
  haptic: true,
});

const swipeStyle = computed(() => {
  if (swipeOffsetX.value <= 0) return { transition: isSwiping.value ? "none" : "transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)" };
  const sign = swipeDirection.value === "right" ? 1 : -1;
  return {
    transform: `translateX(${sign * swipeOffsetX.value}px)`,
    transition: isSwiping.value ? "none" : "transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
  };
});

const swipeArrowOpacity = computed(() => Math.min(swipeOffsetX.value / 60, 1));

const onDeleteAction = () => { emit("delete", props.message); };
const onForwardAction = () => { emit("forward", props.message); };

const chatStore = useChatStore();
const themeStore = useThemeStore();
const isSelected = computed(() => chatStore.selectedMessageIds.has(props.message.id));

const senderDisplayResult = computed(() => {
  const raw = chatStore.getDisplayName(props.message.senderId);
  return getUserDisplayNameForUI(raw, t("common.unknownUser"));
});

/** Compute image placeholder/display styles using known dimensions */
const imagePlaceholderStyle = computed(() => {
  const fi = props.message.fileInfo;
  const w = fi?.w;
  const h = fi?.h;
  if (w && h) {
    const maxW = imageMaxW.value;
    const maxH = 460;
    const scale = Math.min(maxW / w, maxH / h, 1);
    return { width: `${Math.round(w * scale)}px`, height: `${Math.round(h * scale)}px` };
  }
  return { width: `${Math.min(256, imageMaxW.value)}px`, height: "192px" };
});

const imageStyle = computed(() => {
  const fi = props.message.fileInfo;
  const w = fi?.w;
  const h = fi?.h;
  if (w && h) {
    const maxW = imageMaxW.value;
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
    const maxW = imageMaxW.value;
    const maxH = 460;
    const scale = Math.min(maxW / w, maxH / h, 1);
    return { width: `${Math.round(w * scale)}px` };
  }
  return { width: `${Math.min(256, imageMaxW.value)}px` };
});

const handleBubbleClick = () => {
  if (chatStore.selectionMode) {
    chatStore.toggleSelection(props.message.id);
  }
};
const { getState, download, saveFile, formatSize } = useFileDownload();
// Toast cached at setup time so the async `handleFileDownload` doesn't re-enter
// the composable after an `await`. useToast() is module-state today and safe
// to re-enter, but keeping the call site at setup matches MediaViewer /
// MessageList / UserEditForm and avoids the "composable after await" Vue
// pitfall if useToast ever starts using inject() / getCurrentInstance.
const { toast: showToast } = useToast();

const time = computed(() => formatTime(new Date(props.message.timestamp)));

const isFile = computed(() => props.message.type === MessageType.file);
const hasFileInfo = computed(() => !!props.message.fileInfo);
// Must use the same cache key as download() — _key (stable clientId) when available,
// otherwise id. Without this, getState and download write to different state entries
// and images show an infinite spinner.
const fileCacheKey = computed(() => props.message._key || props.message.id);
const fileState = computed(() => getState(fileCacheKey.value));

const inlineVideoRef = ref<HTMLVideoElement | null>(null);
useVideoStatePreservation(inlineVideoRef, fileCacheKey, { dontResumePlay: true });

// Telegram-style video bubble (WEE-32): show a generated first-frame poster
// + center play button + bottom-right duration badge instead of a bare
// `<video controls>`. Native controls only appear once the user taps play.
const isVideoPlaying = ref(false);
const videoPosterUrl = ref<string | null>(null);
const videoMetaDuration = ref<number | null>(null);
const lastPosterSource = ref<string | null>(null);
// Tracks whether this component instance is still alive: the virtual scroller
// recycles bubbles aggressively, so an in-flight `extractVideoFrameThumbnail`
// can resolve after the bubble's scope is gone. Writing to a dead ref would
// leak the generated blob URL until the page reloads.
let isBubbleAlive = true;

const videoDurationSeconds = computed(() => {
  const fromMeta = props.message.fileInfo?.duration;
  if (typeof fromMeta === "number" && fromMeta > 0) return fromMeta;
  return videoMetaDuration.value ?? undefined;
});
const videoDurationText = computed(() => formatVideoDuration(videoDurationSeconds.value));

const revokePoster = () => {
  if (videoPosterUrl.value) {
    try { URL.revokeObjectURL(videoPosterUrl.value); } catch { /* ignore */ }
    videoPosterUrl.value = null;
  }
};

watch(
  () => fileState.value.objectUrl,
  async (url, prevUrl) => {
    if (url === prevUrl) return;
    if (props.message.type !== MessageType.video) return;
    revokePoster();
    lastPosterSource.value = url ?? null;
    if (!url) return;
    const source = url;
    const thumb = await extractVideoFrameThumbnail(source);
    // Bail if the bubble was recycled or unmounted before extraction finished
    // — the poster would belong to a different (or no) video.
    if (!thumb) return;
    if (!isBubbleAlive || lastPosterSource.value !== source) {
      try { URL.revokeObjectURL(thumb); } catch { /* ignore */ }
      return;
    }
    videoPosterUrl.value = thumb;
  },
  { immediate: true },
);

watch(
  () => props.message.id,
  () => {
    isVideoPlaying.value = false;
    videoMetaDuration.value = null;
    // Recycled bubble: drop the stale poster + source guard so the next
    // objectUrl write triggers a fresh extraction (the `url === prevUrl`
    // short-circuit can otherwise pin us to the previous message's poster).
    revokePoster();
    lastPosterSource.value = null;
    // Drop the previous video's playback error so the next message doesn't
    // inherit a stale codec-unsupported overlay (WEE-21).
    videoPlaybackError.value = null;
    clearVideoLoadTimer();
  },
);

onBeforeUnmount(() => {
  isBubbleAlive = false;
  revokePoster();
  clearVideoLoadTimer();
});

const onInlineVideoLoadedMetadata = () => {
  // First successful frame of metadata = decoder is alive. Disarm the
  // 10s timeout so a slow `canplay` on a long video doesn't trip it.
  clearVideoLoadTimer();
  videoPlaybackError.value = null;
  const el = inlineVideoRef.value;
  if (el && Number.isFinite(el.duration) && el.duration > 0) {
    videoMetaDuration.value = el.duration;
  }
};

const playInlineVideo = () => {
  const el = inlineVideoRef.value;
  if (!el) return;
  // `isVideoPlaying` is wired to the @play / @pause / @ended events on the
  // <video> element, so the overlay hides only once playback is actually
  // running. Flipping it here would briefly show native controls on a paused
  // element if play() rejects (autoplay/focus interrupt on Android WebView).
  const result = el.play();
  if (result && typeof (result as Promise<void>).catch === "function") {
    (result as Promise<void>).catch(() => { /* @pause handler resets state */ });
  }
};

// ── Video playback state machine (WEE-21) ──
// Pre-fix, a failed decrypt/decode/codec-mismatch surfaced as an eternal
// spinner or the bare Android WebView "green icon" placeholder. The state
// below routes those failures into a typed UX with a retry / download
// fallback. See `model/video-error.ts` for the MediaError → typed mapping.
const videoPlaybackError = ref<VideoPlaybackError | null>(null);
let videoLoadTimer: ReturnType<typeof setTimeout> | null = null;

const clearVideoLoadTimer = () => {
  if (videoLoadTimer !== null) {
    clearTimeout(videoLoadTimer);
    videoLoadTimer = null;
  }
};

const armVideoLoadTimer = () => {
  clearVideoLoadTimer();
  videoLoadTimer = setTimeout(() => {
    videoLoadTimer = null;
    // Only surface a timeout if the element never reached a playable state.
    // `loadedmetadata` is the earliest signal that decoding works at all;
    // once that fires we clear the timer eagerly so the deadline is moot.
    // The `videoPlaybackError === null` guard prevents the timer from
    // clobbering a more specific error (decode / codec-unsupported) that
    // arrived via `@error` between arming and the deadline — Android WebView
    // can fire synchronous errors on `el.load()` during retry, so without
    // this check the typed copy would silently revert to "timeout" 10s later.
    if (
      !isVideoPlaying.value &&
      videoMetaDuration.value === null &&
      videoPlaybackError.value === null
    ) {
      videoPlaybackError.value = "timeout";
    }
  }, VIDEO_LOAD_TIMEOUT_MS);
};

const onInlineVideoError = (event: Event) => {
  clearVideoLoadTimer();
  const target = event.target as HTMLVideoElement | null;
  videoPlaybackError.value = videoPlaybackErrorFromMediaError(target?.error?.code);
};

const onInlineVideoCanPlay = () => {
  clearVideoLoadTimer();
  videoPlaybackError.value = null;
};

const videoErrorMessage = computed(() => {
  switch (videoPlaybackError.value) {
    case "codec-unsupported":
      return t("message.videoUnsupportedFormat");
    case "decode":
    case "timeout":
    case "generic":
      return t("message.videoLoadFailed");
    default:
      return "";
  }
});

// Codec-unsupported can't be retried — the WebView genuinely lacks the
// decoder, so re-fetching the same bytes won't help. All other errors
// (decode/timeout/generic) are potentially transient, so a retry is the
// right affordance alongside the download fallback.
const videoCanRetry = computed(() => videoPlaybackError.value !== "codec-unsupported");

const retryVideoPlayback = () => {
  videoPlaybackError.value = null;
  const el = inlineVideoRef.value;
  if (el) {
    try { el.load(); } catch { /* WebView edge case — ignore */ }
  }
  if (fileState.value.objectUrl) {
    armVideoLoadTimer();
  } else {
    download(props.message);
  }
};

// Arm the load-deadline as soon as a fresh blob URL is wired into <video>.
// Disarming happens on `loadedmetadata` / `canplay` (success) or in
// `onInlineVideoError` (failure) — no leak even if the bubble unmounts
// mid-load, because `onBeforeUnmount` also calls `clearVideoLoadTimer`.
watch(
  () => fileState.value.objectUrl,
  (url, prevUrl) => {
    if (url === prevUrl) return;
    if (props.message.type !== MessageType.video) return;
    clearVideoLoadTimer();
    videoPlaybackError.value = null;
    if (url) armVideoLoadTimer();
  },
);

/** Telegram-style sender colors (same palette as Avatar) */
const SENDER_COLORS = ["#E17076", "#FAA774", "#A695E7", "#7BC862", "#6EC9CB", "#65AADD", "#EE7AAE"];
function hashStr(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h); }
const senderColor = computed(() => SENDER_COLORS[hashStr(props.message.senderId) % SENDER_COLORS.length]);

const msgStatus = computed(() => props.message.status);
const isRead = computed(() => props.message.status === MessageStatus.read);
const isSending = computed(() => props.message.status === MessageStatus.sending);
const isUploading = computed(() =>
  props.message.status === MessageStatus.sending &&
  props.message.uploadProgress !== undefined
);
const isFailed = computed(() => props.message.status === MessageStatus.failed);

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

// In-flight guard for the file/audio bubble save button: prevents 5 rapid
// taps from creating 5 duplicate downloads (forta-bugs#758, WEE-25).
const isSavingFile = ref(false);

const handleFileDownload = async () => {
  if (isSavingFile.value) return;
  if (!props.message.fileInfo) return;
  isSavingFile.value = true;
  try {
    const url = fileState.value.objectUrl ?? await download(props.message);
    if (!url) return;
    const mime = props.message.fileInfo.type || "";
    const isMedia = mime.startsWith("image/") || mime.startsWith("video/");
    try {
      await saveFile(url, props.message.fileInfo.name, mime);
      showToast(t(isMedia ? "media.savedToGallery" : "media.savedToDownloads"), "success");
    } catch (e) {
      console.error("[MessageBubble] save failed:", e);
      showToast(t("media.saveFailed"), "error");
    }
  } finally {
    isSavingFile.value = false;
  }
};

const retryDownload = () => {
  // Clear stale error so download() can run again
  const state = getState(fileCacheKey.value);
  state.error = null;
  state.errorKind = null;
  download(props.message);
};

/** Manual escape hatch for crypto/decryption errors: the auto-bug-report
 *  pipeline blacklists those failures (#290–300), so the user explicitly
 *  opens the modal from the friendly error UI when they really want to
 *  report it. */
const reportDownloadProblem = () => {
  useBugReport().open({
    context: tRaw("bugReport.ctx.fileDownload"),
    error: fileState.value.error ?? "Unknown file-download error",
  });
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
  if (reply.deleted) return t("message.deleted");
  if (!reply.senderId && !reply.content) return "...";
  if (reply.type === MessageType.image) return "Photo";
  if (reply.type === MessageType.video) return "Video";
  if (reply.type === MessageType.videoCircle) return "Video message";
  if (reply.type === MessageType.audio) return "Voice message";
  if (reply.type === MessageType.file) return reply.content || "File";
  const text = stripBastyonLinks(stripMentionAddresses(reply.content));
  return (text.length > 100 ? text.slice(0, 100) + "\u2026" : text) || "...";
});

const replyPreviewSender = computed(() => {
  const reply = props.message.replyTo;
  if (!reply || reply.deleted) return "";
  if (!reply.senderId) return "...";
  return chatStore.getDisplayName(reply.senderId);
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
    <!-- Swipe reply arrow (behind message, shown on left swipe) -->
    <div
      v-if="swipeOffsetX > 0 && swipeDirection === 'left'"
      class="absolute right-0 top-1/2 flex h-8 w-8 translate-x-10 -translate-y-1/2 items-center justify-center rounded-full bg-color-bg-ac text-white"
      :style="{ opacity: swipeArrowOpacity }"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 17 4 12 9 7" />
        <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
      </svg>
    </div>

    <!-- Reveal actions (behind message, for own messages on right swipe) -->
    <div
      v-if="isOwn && swipeDirection === 'right' && swipeOffsetX > 0"
      class="absolute left-0 top-0 bottom-0 flex items-center gap-1 pl-2"
      :class="{ 'pointer-events-none': isSwiping }"
    >
      <button @click="onDeleteAction" class="flex size-10 items-center justify-center rounded-full bg-color-bad/20 text-color-bad">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
      <button @click="onForwardAction" class="flex size-10 items-center justify-center rounded-full bg-color-bg-ac/20 text-color-bg-ac">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 17 20 12 15 7" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" />
        </svg>
      </button>
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
    <div class="relative min-w-0 max-w-[85%] md:max-w-[80%] lg:max-w-[65%] overflow-hidden">
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
          class="mx-2 mt-1.5 flex items-start gap-1.5 overflow-hidden rounded-lg px-2 py-1"
          :class="[props.isOwn ? 'bg-white/10' : 'bg-black/5', message.replyTo?.deleted ? 'cursor-default' : 'cursor-pointer']"
          @click.stop="!message.replyTo?.deleted && emit('scrollToReply', message.replyTo.id)"
        >
          <div class="w-0.5 shrink-0 self-stretch rounded-full"
            :class="props.isOwn ? 'bg-white/70' : 'bg-color-bg-ac'" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-medium"
              :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
              {{ replyPreviewSender }}
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
            <div class="contain-strict h-8 w-8 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
          </div>
          <div
            v-else-if="fileState.error && fileState.errorKind === 'crypto'"
            class="flex flex-col items-center justify-center gap-1 bg-neutral-grad-0 px-3 py-2 text-center text-xs text-color-bad"
            :style="imagePlaceholderStyle"
          >
            <span class="font-medium">{{ t('chat.decryptError.title') }}</span>
            <span class="text-[10px] opacity-70">{{ isOwn ? t('chat.decryptError.askSelf') : t('chat.decryptError.askResend') }}</span>
            <div class="mt-1 flex items-center gap-2">
              <button type="button" class="rounded-md bg-color-bg-ac px-2 py-0.5 text-[11px] font-medium text-text-on-bg-ac-color" @click.stop="retryDownload">{{ t('chat.decryptError.retry') }}</button>
              <button type="button" class="text-[10px] underline opacity-70" @click.stop="reportDownloadProblem">{{ t('chat.decryptError.reportProblem') }}</button>
            </div>
          </div>
          <div
            v-else-if="fileState.error"
            class="flex cursor-pointer flex-col items-center justify-center gap-1 bg-neutral-grad-0 text-xs text-color-bad"
            :style="imagePlaceholderStyle"
            @click.stop="retryDownload"
          >
            <span>{{ t('message.failedToLoadImage') }}</span>
            <span class="text-[10px] opacity-60">{{ t('message.tapToRetry') }}</span>
          </div>
          <img v-else-if="fileState.objectUrl" :src="fileState.objectUrl" :alt="message.fileInfo?.name" class="block max-h-[460px] max-w-full object-cover" :style="imageStyle" @load="emit('resize')" />
          <!-- Upload progress overlay -->
          <div v-if="isUploading" class="absolute inset-0 flex items-center justify-center bg-black/30">
            <button class="relative flex h-14 w-14 items-center justify-center" @click.stop="emit('cancelUpload', message)">
              <svg class="h-full w-full" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15" fill="none" stroke="white" stroke-opacity="0.3" stroke-width="2.5" />
                <circle cx="18" cy="18" r="15" fill="none" stroke="white" stroke-width="2.5"
                  :stroke-dasharray="94.25" :stroke-dashoffset="94.25 - (94.25 * (message.uploadProgress ?? 0) / 100)"
                  stroke-linecap="round" transform="rotate(-90 18 18)" class="transition-[stroke-dashoffset] duration-300" />
              </svg>
              <svg class="absolute h-3.5 w-3.5" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="white" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <!-- Sending spinner (no progress info, legacy fallback) -->
          <div v-else-if="isSending" class="absolute inset-0 flex items-center justify-center bg-black/30">
            <div class="contain-strict h-8 w-8 animate-spin rounded-full border-3 border-white border-t-transparent" />
          </div>
          <!-- Failed overlay with retry -->
          <div v-if="isFailed && hasFileInfo" class="absolute inset-0 flex items-center justify-center bg-black/40">
            <button class="flex flex-col items-center gap-1 text-white" @click.stop="emit('retryMedia', message)">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              <span class="text-xs font-medium">{{ t('message.retry') }}</span>
            </button>
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
          <ReactionRow :reactions="message.reactions" :is-own="props.isOwn" :my-address="props.myAddress" :message-id="message.id" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
        </div>

      </div>

      <!-- Video Circle (video note) message -->
      <div
        v-else-if="message.type === MessageType.videoCircle && hasFileInfo"
        class="relative inline-block"
      >
        <!-- Forwarded indicator -->
        <div v-if="message.forwardedFrom" class="mb-1 truncate text-[11px] italic"
          :class="props.isOwn ? 'text-text-on-bg-ac-color/70' : 'text-color-bg-ac'">
          {{ t("message.forwardedFrom", { name: forwardedFromName }) }}
        </div>
        <VideoCirclePlayer :message="message" :is-own="props.isOwn" />
        <!-- Upload progress overlay for video circle -->
        <div v-if="isUploading" class="absolute inset-0 flex items-center justify-center rounded-full bg-black/30">
          <button class="relative flex h-14 w-14 items-center justify-center" @click.stop="emit('cancelUpload', message)">
            <svg class="h-full w-full" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15" fill="none" stroke="white" stroke-opacity="0.3" stroke-width="2.5" />
              <circle cx="18" cy="18" r="15" fill="none" stroke="white" stroke-width="2.5"
                :stroke-dasharray="94.25" :stroke-dashoffset="94.25 - (94.25 * (message.uploadProgress ?? 0) / 100)"
                stroke-linecap="round" transform="rotate(-90 18 18)" class="transition-[stroke-dashoffset] duration-300" />
            </svg>
            <svg class="absolute h-3.5 w-3.5" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="white" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <div v-else-if="isSending" class="absolute inset-0 flex items-center justify-center rounded-full bg-black/30">
          <div class="contain-strict h-8 w-8 animate-spin rounded-full border-3 border-white border-t-transparent" />
        </div>
        <div v-if="isFailed && hasFileInfo" class="absolute inset-0 flex items-center justify-center rounded-full bg-black/40">
          <button class="flex flex-col items-center gap-1 text-white" @click.stop="emit('retryMedia', message)">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            <span class="text-xs font-medium">{{ t('message.retry') }}</span>
          </button>
        </div>
        <!-- Timestamp below the circle -->
        <div v-if="themeStore.showTimestamps" class="mt-1 flex items-center gap-1" :class="props.isOwn ? 'justify-end text-text-on-main-bg-color' : 'text-text-on-main-bg-color'">
          <span class="text-[10px]">{{ time }}</span>
          <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
        </div>
        <!-- Reactions row -->
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" :my-address="props.myAddress" :message-id="message.id" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
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
          class="mx-2 mt-1.5 flex items-start gap-1.5 overflow-hidden rounded-lg px-2 py-1"
          :class="[props.isOwn ? 'bg-white/10' : 'bg-black/5', message.replyTo?.deleted ? 'cursor-default' : 'cursor-pointer']"
          @click.stop="!message.replyTo?.deleted && emit('scrollToReply', message.replyTo.id)"
        >
          <div class="w-0.5 shrink-0 self-stretch rounded-full"
            :class="props.isOwn ? 'bg-white/70' : 'bg-color-bg-ac'" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-medium"
              :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
              {{ replyPreviewSender }}
            </div>
            <div class="truncate text-[11px] opacity-70">{{ replyPreviewText }}</div>
          </div>
        </div>
        <div class="relative aspect-video w-full overflow-hidden bg-black/90">
          <video
            v-if="fileState.objectUrl"
            ref="inlineVideoRef"
            :src="fileState.objectUrl"
            :poster="videoPosterUrl ?? undefined"
            :controls="isVideoPlaying"
            :controlslist="isVideoPlaying ? 'nodownload' : undefined"
            playsinline
            preload="metadata"
            class="block h-full w-full object-cover"
            @loadedmetadata="onInlineVideoLoadedMetadata"
            @canplay="onInlineVideoCanPlay"
            @error="onInlineVideoError"
            @play="isVideoPlaying = true"
            @pause="isVideoPlaying = false"
            @ended="isVideoPlaying = false"
          />
          <div v-else-if="fileState.loading" class="flex h-full w-full items-center justify-center bg-neutral-grad-0">
            <div class="contain-strict h-8 w-8 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
          </div>
          <button v-else type="button" class="flex h-full w-full items-center justify-center bg-neutral-grad-0 transition-colors hover:bg-neutral-grad-2" @click="handleVideoAudioLoad">
            <span class="flex h-14 w-14 items-center justify-center rounded-full bg-color-bg-ac/90 text-white shadow-lg">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
            </span>
          </button>
          <button
            v-if="fileState.objectUrl && !isVideoPlaying && !isUploading && !isSending && !isFailed && !videoPlaybackError"
            type="button"
            class="absolute inset-0 flex items-center justify-center bg-black/15 transition-colors hover:bg-black/25"
            aria-label="Play video"
            @click.stop="playInlineVideo"
          >
            <span class="flex h-14 w-14 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm shadow-lg ring-1 ring-white/15">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="6 4 20 12 6 20 6 4" /></svg>
            </span>
          </button>
          <div
            v-if="videoDurationText && !isVideoPlaying && !videoPlaybackError"
            class="pointer-events-none absolute bottom-2 right-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium leading-none text-white"
          >
            {{ videoDurationText }}
          </div>
          <!--
            Typed playback-error overlay (WEE-21). Sits above the duration
            badge / play-button overlay so a failed decode shows specific
            UX instead of an eternal spinner. Codec-unsupported renders
            only the download button; transient errors add a retry.
          -->
          <div
            v-if="videoPlaybackError && !isUploading && !isSending"
            class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-4 text-center text-white"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span class="text-xs font-medium">{{ videoErrorMessage }}</span>
            <div class="flex gap-2">
              <button
                v-if="videoCanRetry"
                type="button"
                class="rounded-md bg-white/15 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/25"
                @click.stop="retryVideoPlayback"
              >
                {{ t('message.retry') }}
              </button>
              <button
                type="button"
                class="rounded-md bg-color-bg-ac px-3 py-1.5 text-xs font-medium text-text-on-bg-ac-color transition-opacity hover:opacity-90 disabled:opacity-60"
                :disabled="isSavingFile"
                @click.stop="handleFileDownload"
              >
                {{ t('message.videoDownload') }}
              </button>
            </div>
          </div>
          <!-- Upload progress overlay for video -->
          <div v-if="isUploading" class="absolute inset-0 flex items-center justify-center bg-black/30">
            <button class="relative flex h-14 w-14 items-center justify-center" @click.stop="emit('cancelUpload', message)">
              <svg class="h-full w-full" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15" fill="none" stroke="white" stroke-opacity="0.3" stroke-width="2.5" />
                <circle cx="18" cy="18" r="15" fill="none" stroke="white" stroke-width="2.5"
                  :stroke-dasharray="94.25" :stroke-dashoffset="94.25 - (94.25 * (message.uploadProgress ?? 0) / 100)"
                  stroke-linecap="round" transform="rotate(-90 18 18)" class="transition-[stroke-dashoffset] duration-300" />
              </svg>
              <svg class="absolute h-3.5 w-3.5" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="white" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <div v-else-if="isSending" class="absolute inset-0 flex items-center justify-center bg-black/30">
            <div class="contain-strict h-8 w-8 animate-spin rounded-full border-3 border-white border-t-transparent" />
          </div>
          <div v-if="isFailed && hasFileInfo && !videoPlaybackError" class="absolute inset-0 flex items-center justify-center bg-black/40">
            <button class="flex flex-col items-center gap-1 text-white" @click.stop="emit('retryMedia', message)">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              <span class="text-xs font-medium">{{ t('message.retry') }}</span>
            </button>
          </div>
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
          <ReactionRow :reactions="message.reactions" :is-own="props.isOwn" :my-address="props.myAddress" :message-id="message.id" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
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
          class="mb-1 flex items-start gap-1.5 overflow-hidden rounded-lg px-2 py-1"
          :class="[props.isOwn ? 'bg-white/10' : 'bg-black/5', message.replyTo?.deleted ? 'cursor-default' : 'cursor-pointer']"
          @click.stop="!message.replyTo?.deleted && emit('scrollToReply', message.replyTo.id)"
        >
          <div class="w-0.5 shrink-0 self-stretch rounded-full"
            :class="props.isOwn ? 'bg-white/70' : 'bg-color-bg-ac'" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-medium"
              :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
              {{ replyPreviewSender }}
            </div>
            <div class="truncate text-[11px] opacity-70">{{ replyPreviewText }}</div>
          </div>
        </div>
        <VoiceMessage :message="message" :is-own="props.isOwn" />
        <!-- Upload progress with cancel for audio -->
        <div v-if="isUploading" class="mt-1 flex items-center gap-2">
          <button class="relative flex h-8 w-8 shrink-0 items-center justify-center" @click.stop="emit('cancelUpload', message)">
            <svg class="h-full w-full" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2.5" />
              <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" stroke-width="2.5"
                :stroke-dasharray="94.25" :stroke-dashoffset="94.25 - (94.25 * (message.uploadProgress ?? 0) / 100)"
                stroke-linecap="round" transform="rotate(-90 18 18)" class="transition-[stroke-dashoffset] duration-300" />
            </svg>
            <svg class="absolute h-2.5 w-2.5" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
          <span class="text-xs opacity-60">{{ message.uploadProgress }}%</span>
        </div>
        <!-- Failed with retry for audio -->
        <div v-if="isFailed && hasFileInfo" class="mt-1 flex items-center gap-2">
          <button class="text-xs font-medium text-color-bg-ac" @click.stop="emit('retryMedia', message)">{{ t('message.retry') }}</button>
          <button class="text-xs opacity-60" @click.stop="emit('cancelUpload', message)">{{ t('messageList.cancel') }}</button>
        </div>
        <div v-if="themeStore.showTimestamps" class="mt-1 flex items-center justify-end gap-1" :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
          <span class="text-[10px]">{{ time }}</span>
          <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
        </div>
        <!-- Reactions row -->
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" :my-address="props.myAddress" :message-id="message.id" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
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
          class="mb-1 flex items-start gap-1.5 overflow-hidden rounded-lg px-2 py-1"
          :class="[props.isOwn ? 'bg-white/10' : 'bg-black/5', message.replyTo?.deleted ? 'cursor-default' : 'cursor-pointer']"
          @click.stop="!message.replyTo?.deleted && emit('scrollToReply', message.replyTo.id)"
        >
          <div class="w-0.5 shrink-0 self-stretch rounded-full"
            :class="props.isOwn ? 'bg-white/70' : 'bg-color-bg-ac'" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-medium"
              :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
              {{ replyPreviewSender }}
            </div>
            <div class="truncate text-[11px] opacity-70">{{ replyPreviewText }}</div>
          </div>
        </div>
        <button
          class="flex w-full items-center gap-3 text-left disabled:opacity-60"
          :disabled="isSavingFile"
          @click="handleFileDownload"
        >
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" :class="props.isOwn ? 'bg-white/20' : 'bg-color-bg-ac/10'">
            <svg v-if="fileState.loading" class="contain-strict h-5 w-5 animate-spin" :class="props.isOwn ? 'text-white' : 'text-color-bg-ac'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="31.4 31.4" /></svg>
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
        <div v-if="fileState.error && fileState.errorKind === 'crypto'" class="mt-1 flex flex-col gap-0.5">
          <p class="text-xs font-medium text-color-bad">{{ t('chat.decryptError.title') }}</p>
          <p class="text-[11px] opacity-70">{{ isOwn ? t('chat.decryptError.askSelf') : t('chat.decryptError.askResend') }}</p>
          <div class="mt-0.5 flex items-center gap-3">
            <button type="button" class="text-xs font-medium text-color-bg-ac" @click.stop="retryDownload">{{ t('chat.decryptError.retry') }}</button>
            <button type="button" class="text-[11px] opacity-60 underline" @click.stop="reportDownloadProblem">{{ t('chat.decryptError.reportProblem') }}</button>
          </div>
        </div>
        <p v-else-if="fileState.error" class="mt-1 text-xs text-color-bad">{{ fileState.error }}</p>
        <!-- Upload progress with cancel for file -->
        <div v-if="isUploading" class="mt-1 flex items-center gap-2">
          <button class="relative flex h-8 w-8 shrink-0 items-center justify-center" @click.stop="emit('cancelUpload', message)">
            <svg class="h-full w-full" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2.5" />
              <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" stroke-width="2.5"
                :stroke-dasharray="94.25" :stroke-dashoffset="94.25 - (94.25 * (message.uploadProgress ?? 0) / 100)"
                stroke-linecap="round" transform="rotate(-90 18 18)" class="transition-[stroke-dashoffset] duration-300" />
            </svg>
            <svg class="absolute h-2.5 w-2.5" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
          <span class="text-xs opacity-60">{{ message.uploadProgress }}%</span>
        </div>
        <!-- Failed with retry for file -->
        <div v-if="isFailed && hasFileInfo" class="mt-1 flex items-center gap-2">
          <button class="text-xs font-medium text-color-bg-ac" @click.stop="emit('retryMedia', message)">{{ t('message.retry') }}</button>
          <button class="text-xs opacity-60" @click.stop="emit('cancelUpload', message)">{{ t('messageList.cancel') }}</button>
        </div>
        <div v-if="message.fileInfo?.caption" class="mt-1 text-chat-base opacity-90">
          <MessageContent :text="message.fileInfo.caption" @mention-click="(userId) => openUserProfile?.(hexDecode(userId))" />
        </div>
        <div v-if="themeStore.showTimestamps" class="mt-1 flex items-center justify-end gap-1" :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
          <span class="text-[10px]">{{ time }}</span>
          <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
        </div>
        <!-- Reactions row -->
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" :my-address="props.myAddress" :message-id="message.id" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
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
          :class="{ 'italic opacity-70': senderDisplayResult.state === 'failed' }"
          :style="{ color: senderColor }"
          @click.stop="openUserProfile?.(message.senderId)"
        >
          {{ senderDisplayResult.text }}
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
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" :my-address="props.myAddress" :message-id="message.id" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
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
          :class="{ 'italic opacity-70': senderDisplayResult.state === 'failed' }"
          :style="{ color: senderColor }"
          @click.stop="openUserProfile?.(message.senderId)"
        >
          {{ senderDisplayResult.text }}
        </div>
        <TransferCard :message="message" :is-own="props.isOwn" />
        <div v-if="themeStore.showTimestamps" class="mt-1 flex items-center justify-end gap-1" :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
          <span class="text-[10px]">{{ time }}</span>
          <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
        </div>
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" :my-address="props.myAddress" :message-id="message.id" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
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
          :class="{ 'italic opacity-70': senderDisplayResult.state === 'failed' }"
          :style="{ color: senderColor }"
          @click.stop="openUserProfile?.(message.senderId)"
        >
          {{ senderDisplayResult.text }}
        </div>

        <!-- Forwarded indicator -->
        <div v-if="message.forwardedFrom" class="mb-0.5 truncate text-[11px] italic"
          :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
          Forwarded from {{ message.forwardedFrom.senderName || chatStore.getDisplayName(message.forwardedFrom.senderId) }}
        </div>

        <!-- Reply preview -->
        <div
          v-if="message.replyTo"
          class="mb-1 flex items-start gap-1.5 overflow-hidden rounded-lg px-2 py-1"
          :class="[props.isOwn ? 'bg-white/10' : 'bg-black/5', message.replyTo?.deleted ? 'cursor-default' : 'cursor-pointer']"
          @click.stop="!message.replyTo?.deleted && emit('scrollToReply', message.replyTo.id)"
        >
          <div class="w-0.5 shrink-0 self-stretch rounded-full"
            :class="props.isOwn ? 'bg-white/70' : 'bg-color-bg-ac'" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-medium"
              :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
              {{ replyPreviewSender }}
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

        <!-- Failed text message: retry bar -->
        <div
          v-if="isFailed && props.isOwn && !hasFileInfo"
          class="mt-1 flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-[#FF4444] cursor-pointer hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          @click.stop="emit('retryMessage', message)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          {{ t('message.retrySend', 'Tap to retry') }}
        </div>

        <!-- Reactions row -->
        <ReactionRow v-if="message.reactions && Object.keys(message.reactions).length" :reactions="message.reactions" :is-own="props.isOwn" :my-address="props.myAddress" :message-id="message.id" @toggle="handleToggleReaction" @add-reaction="handleAddReaction" />
      </div>
    </div>
  </div>
</template>

