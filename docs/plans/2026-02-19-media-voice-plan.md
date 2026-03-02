# Media, Captions & Voice Messages Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Telegram-style media upload with captions, voice recording (hold/lock/cancel), and voice message playback with waveform visualization — compatible with bastyon-chat message format.

**Architecture:** Approach B — dedicated composables (`use-voice-recorder.ts`, `use-media-upload.ts`) and components (`MediaPreview.vue`, `VoiceRecorder.vue`, `VoiceMessage.vue`) integrated into existing MessageInput/MessageBubble. Separate send functions per media type (m.image, m.video, m.audio, m.file).

**Tech Stack:** Vue 3 + TypeScript, Pinia, matrix-js-sdk-bastyon, audio-recorder-polyfill + mpeg-encoder (MP3), HTML5 Audio API, Canvas (waveform)

---

## Batch 1: Foundation — Types + Send Pipeline + Caption Rendering

### Task 1: Extend FileInfo and add m.audio/m.video parsing

**Files:**
- Modify: `src/entities/chat/model/types.ts`
- Modify: `src/entities/chat/lib/chat-helpers.ts`

**Step 1: Extend FileInfo interface**

In `src/entities/chat/model/types.ts`, add new optional fields to `FileInfo`:

```ts
export interface FileInfo {
  name: string;
  type: string;
  size: number;
  url: string;
  secrets?: {
    block: number;
    keys: string;
    v: number;
  };
  w?: number;
  h?: number;
  /** Duration in seconds (audio/video) */
  duration?: number;
  /** RMS waveform data for voice messages (~50 values 0-1) */
  waveform?: number[];
  /** Caption text attached to media */
  caption?: string;
  /** If true, caption renders above media (Telegram feature) */
  captionAbove?: boolean;
}
```

**Step 2: Add m.audio and m.video parsing to chat-helpers.ts**

Add two new branches in `parseFileInfo` — after the `m.image` branch and before the JSON fallback:

```ts
if (msgtype === "m.audio" && info) {
  return {
    name: (content.body as string) ?? "Audio",
    type: info.mimetype ?? "audio/mpeg",
    size: info.size ?? 0,
    url: info.url ?? (content.url as string) ?? "",
    duration: info.duration ? Math.round(info.duration / 1000) : undefined,
    waveform: info.waveform,
    secrets: info.secrets ? {
      block: info.secrets.block,
      keys: info.secrets.keys,
      v: info.secrets.v ?? info.secrets.version ?? 1,
    } : undefined,
  };
}

if (msgtype === "m.video") {
  const url = info?.url ?? (content.url as string) ?? "";
  return {
    name: (content.body as string) ?? "Video",
    type: info?.mimetype ?? "video/mp4",
    size: info?.size ?? 0,
    url,
    w: info?.w,
    h: info?.h,
    duration: info?.duration ? Math.round(info.duration / 1000) : undefined,
    secrets: info?.secrets ? {
      block: info.secrets.block,
      keys: info.secrets.keys,
      v: info.secrets.v ?? info.secrets.version ?? 1,
    } : undefined,
  };
}
```

Also update `messageTypeFromMime` — no changes needed, it already handles all MIME types correctly.

**Step 3: Update the timeline event handler in matrix-client.ts**

In `src/entities/matrix/model/matrix-client.ts`, in `initEvents()` method, the `Room.timeline` handler currently only parses `m.file` body as JSON. We need to handle `m.image`/`m.audio`/`m.video` events properly. Find the block:

```ts
if (msg.event.content.msgtype === "m.file") {
  try { msg.event.content.pbody = JSON.parse(msg.event.content.body); } catch { /* ignore */ }
}
```

Replace with:

```ts
// Parse m.file body as JSON (bastyon-chat format)
if (msg.event.content.msgtype === "m.file") {
  try { msg.event.content.pbody = JSON.parse(msg.event.content.body); } catch { /* ignore */ }
}
// For m.image/m.audio/m.video, ensure info is available for parseFileInfo
// (these come through natively from the SDK, no extra parsing needed)
```

No actual code change needed — these events already flow through `onTimeline` and the `parseFileInfo` function handles them. The comment clarifies intent.

**Step 4: Verify build**

Run: `npx vite build`

---

### Task 2: Add upload progress support to MatrixClientService

**Files:**
- Modify: `src/entities/matrix/model/matrix-client.ts`

**Step 1: Add progressHandler to uploadContent**

Replace the existing `uploadContent` method:

```ts
/** Upload content to Matrix server.
 *  @param progressHandler — optional callback receiving { loaded, total } */
async uploadContent(file: Blob, progressHandler?: (progress: { loaded: number; total: number }) => void): Promise<string> {
  if (!this.client) throw new Error("Client not initialized");
  const opts: Record<string, unknown> = {};
  if (progressHandler) {
    opts.progressHandler = progressHandler;
  }
  const src = await this.client.uploadContent(file, opts);
  return this.client.mxcUrlToHttp(src.content_uri);
}
```

**Step 2: Verify build**

Run: `npx vite build`

---

### Task 3: Refactor use-messages.ts — add sendImage, sendAudio functions

**Files:**
- Modify: `src/features/messaging/model/use-messages.ts`

**Step 1: Add sendImage function**

Add after the existing `sendFile` function:

```ts
/** Send an image message (m.image event — compatible with bastyon-chat) */
const sendImage = async (file: File, options: { caption?: string; captionAbove?: boolean } = {}) => {
  const roomId = chatStore.activeRoomId;
  if (!roomId || !file) return;

  const matrixService = getMatrixClientService();
  if (!matrixService.isReady()) return;

  // Get image dimensions
  const dimensions = await getImageDimensions(file);

  // Optimistic message
  const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const message: Message = {
    id: tempId,
    roomId,
    senderId: authStore.address ?? "",
    content: options.caption || file.name,
    timestamp: Date.now(),
    status: MessageStatus.sending,
    type: MessageType.image,
    fileInfo: {
      name: file.name,
      type: file.type,
      size: file.size,
      url: "",
      w: dimensions.w,
      h: dimensions.h,
      caption: options.caption,
      captionAbove: options.captionAbove,
    },
  };
  chatStore.addMessage(roomId, message);

  try {
    const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

    let fileToUpload: Blob = file;
    let secrets: Record<string, unknown> | undefined;

    if (roomCrypto?.canBeEncrypt()) {
      const encrypted = await roomCrypto.encryptFile(file);
      secrets = encrypted.secrets;
      fileToUpload = encrypted.file;
    }

    const url = await matrixService.uploadContent(fileToUpload);

    // Build m.image content (bastyon-chat compatible)
    const content: Record<string, unknown> = {
      body: options.caption || "Image",
      msgtype: "m.image",
      url,
      info: {
        w: dimensions.w,
        h: dimensions.h,
        mimetype: file.type,
        size: file.size,
        ...(secrets ? { secrets } : {}),
      },
    };

    const serverEventId = await matrixService.sendEncryptedText(roomId, content);
    if (serverEventId) chatStore.updateMessageId(roomId, tempId, serverEventId);
    chatStore.updateMessageStatus(roomId, serverEventId || tempId, MessageStatus.sent);
  } catch (e) {
    console.error("Failed to send image:", e);
    chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
  }
};
```

**Step 2: Add getImageDimensions helper**

Add at the top of the function body (inside `useMessages`):

```ts
/** Extract width/height from an image file */
const getImageDimensions = (file: File): Promise<{ w: number; h: number }> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = URL.createObjectURL(file);
  });
};
```

**Step 3: Add sendAudio function**

```ts
/** Send an audio/voice message (m.audio event — compatible with bastyon-chat) */
const sendAudio = async (file: File, options: { duration?: number; waveform?: number[] } = {}) => {
  const roomId = chatStore.activeRoomId;
  if (!roomId || !file) return;

  const matrixService = getMatrixClientService();
  if (!matrixService.isReady()) return;

  const tempId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const message: Message = {
    id: tempId,
    roomId,
    senderId: authStore.address ?? "",
    content: "Audio",
    timestamp: Date.now(),
    status: MessageStatus.sending,
    type: MessageType.audio,
    fileInfo: {
      name: file.name,
      type: file.type,
      size: file.size,
      url: "",
      duration: options.duration,
      waveform: options.waveform,
    },
  };
  chatStore.addMessage(roomId, message);

  try {
    const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;

    let fileToUpload: Blob = file;
    let secrets: Record<string, unknown> | undefined;

    if (roomCrypto?.canBeEncrypt()) {
      const encrypted = await roomCrypto.encryptFile(file);
      secrets = encrypted.secrets;
      fileToUpload = encrypted.file;
    }

    const url = await matrixService.uploadContent(fileToUpload);

    const content: Record<string, unknown> = {
      body: "Audio",
      msgtype: "m.audio",
      url,
      info: {
        mimetype: file.type,
        size: file.size,
        duration: options.duration ? options.duration * 1000 : undefined,
        waveform: options.waveform,
        ...(secrets ? { secrets } : {}),
      },
    };

    const serverEventId = await matrixService.sendEncryptedText(roomId, content);
    if (serverEventId) chatStore.updateMessageId(roomId, tempId, serverEventId);
    chatStore.updateMessageStatus(roomId, serverEventId || tempId, MessageStatus.sent);
  } catch (e) {
    console.error("Failed to send audio:", e);
    chatStore.updateMessageStatus(roomId, tempId, MessageStatus.failed);
  }
};
```

**Step 4: Update the return statement**

Add `sendImage` and `sendAudio` to the return object:

```ts
return {
  deleteMessage,
  editMessage,
  forwardMessage,
  loadMessages,
  sendAudio,
  sendFile,
  sendImage,
  sendMessage,
  sendReply,
  setTyping,
  toggleReaction,
};
```

**Step 5: Verify build**

Run: `npx vite build`

---

### Task 4: Add caption rendering to MessageBubble

**Files:**
- Modify: `src/features/messaging/ui/MessageBubble.vue`

**Step 1: Add caption block to image message**

In the image message section, after the `<img>` container and its timestamp overlay, before the reactions row — add caption rendering:

Find the `<!-- Reactions row -->` comment inside the image section and add before it:

```html
<!-- Caption -->
<div
  v-if="message.fileInfo?.caption"
  class="px-3 py-1.5 text-chat-base"
  :class="props.isOwn ? 'text-text-on-bg-ac-color' : 'text-text-color'"
>
  <MessageContent :text="message.fileInfo.caption" />
  <span
    v-if="themeStore.showTimestamps"
    class="relative -bottom-[3px] ml-2 inline-flex items-center gap-0.5 whitespace-nowrap align-bottom text-[10px]"
    :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'"
  >
    {{ time }}
    <MessageStatusIcon v-if="props.isOwn" :status="msgStatus" />
  </span>
</div>
```

When a caption is present, the timestamp overlay on the image itself should be hidden (since timestamp is now in the caption). Wrap the timestamp overlay with:

```html
<div v-if="themeStore.showTimestamps && !message.fileInfo?.caption" class="absolute bottom-1 right-2 ...">
```

**Step 2: Add caption to video message**

Same pattern — add caption block after the video filename row and before reactions. Also update video footer to hide when caption exists.

**Step 3: Add caption to file message**

After the file download button block, add:

```html
<div v-if="message.fileInfo?.caption" class="mt-1 text-chat-base opacity-90">
  <MessageContent :text="message.fileInfo.caption" />
</div>
```

**Step 4: Verify build**

Run: `npx vite build`

---

## Batch 2: MediaPreview + Captions

### Task 5: Create use-media-upload composable

**Files:**
- Create: `src/features/messaging/model/use-media-upload.ts`

```ts
import { ref, computed } from "vue";
import type { Ref } from "vue";

export interface MediaFile {
  file: File;
  previewUrl: string;
  type: "image" | "video";
}

export function useMediaUpload() {
  const files: Ref<MediaFile[]> = ref([]);
  const activeIndex = ref(0);
  const caption = ref("");
  const captionAbove = ref(false);
  const sending = ref(false);

  const activeFile = computed(() => files.value[activeIndex.value] ?? null);

  const addFiles = (fileList: FileList | File[]) => {
    for (const file of Array.from(fileList)) {
      const type = file.type.startsWith("video/") ? "video" as const : "image" as const;
      files.value.push({
        file,
        previewUrl: URL.createObjectURL(file),
        type,
      });
    }
    activeIndex.value = 0;
  };

  const removeFile = (index: number) => {
    const removed = files.value.splice(index, 1);
    removed.forEach(f => URL.revokeObjectURL(f.previewUrl));
    if (activeIndex.value >= files.value.length) {
      activeIndex.value = Math.max(0, files.value.length - 1);
    }
  };

  const clear = () => {
    files.value.forEach(f => URL.revokeObjectURL(f.previewUrl));
    files.value = [];
    activeIndex.value = 0;
    caption.value = "";
    captionAbove.value = false;
    sending.value = false;
  };

  return { files, activeIndex, activeFile, caption, captionAbove, sending, addFiles, removeFile, clear };
}
```

**Verify:** `npx vite build`

---

### Task 6: Create MediaPreview component

**Files:**
- Create: `src/features/messaging/ui/MediaPreview.vue`

This is a fullscreen Teleport-to-body panel that shows selected media with a caption input and send button.

```vue
<script setup lang="ts">
import { ref, watch } from "vue";
import type { MediaFile } from "../model/use-media-upload";

interface Props {
  show: boolean;
  files: MediaFile[];
  activeIndex: number;
  caption: string;
  captionAbove: boolean;
  sending: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
  send: [];
  "update:activeIndex": [index: number];
  "update:caption": [value: string];
  "update:captionAbove": [value: boolean];
  removeFile: [index: number];
}>();

const showCaptionMenu = ref(false);

const activeFile = computed(() => props.files[props.activeIndex] ?? null);

const handleSend = () => {
  emit("send");
};

const toggleCaptionPosition = () => {
  emit("update:captionAbove", !props.captionAbove);
  showCaptionMenu.value = false;
};
</script>

<template>
  <Teleport to="body">
    <transition name="media-preview">
      <div v-if="props.show && files.length > 0" class="fixed inset-0 z-50 flex flex-col bg-black/95">
        <!-- Top bar -->
        <div class="flex shrink-0 items-center justify-between px-4 py-3">
          <button
            class="flex h-10 w-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10"
            @click="emit('close')"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18" /><path d="M6 6l12 12" />
            </svg>
          </button>
          <span class="text-sm text-white/60">{{ props.activeIndex + 1 }} / {{ files.length }}</span>
          <div class="w-10" />
        </div>

        <!-- Main media area -->
        <div class="flex flex-1 items-center justify-center overflow-hidden px-4">
          <template v-if="activeFile">
            <img
              v-if="activeFile.type === 'image'"
              :src="activeFile.previewUrl"
              class="max-h-full max-w-full object-contain"
            />
            <video
              v-else
              :src="activeFile.previewUrl"
              controls
              class="max-h-full max-w-full"
            />
          </template>
        </div>

        <!-- Thumbnail strip (multiple files) -->
        <div v-if="files.length > 1" class="flex shrink-0 gap-2 overflow-x-auto px-4 py-2">
          <button
            v-for="(f, i) in files"
            :key="i"
            class="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 transition-all"
            :class="i === props.activeIndex ? 'border-white' : 'border-transparent opacity-60'"
            @click="emit('update:activeIndex', i)"
          >
            <img v-if="f.type === 'image'" :src="f.previewUrl" class="h-full w-full object-cover" />
            <div v-else class="flex h-full w-full items-center justify-center bg-white/10">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="text-white"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            </div>
            <!-- Remove button -->
            <button
              class="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white"
              @click.stop="emit('removeFile', i)"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <path d="M18 6L6 18" /><path d="M6 6l12 12" />
              </svg>
            </button>
          </button>
        </div>

        <!-- Caption input + send -->
        <div class="shrink-0 border-t border-white/10 px-4 py-3">
          <div class="flex items-end gap-3">
            <input
              :value="props.caption"
              type="text"
              placeholder="Add a caption..."
              maxlength="1024"
              class="flex-1 rounded-xl bg-white/10 px-4 py-2.5 text-sm text-white outline-none placeholder:text-white/40"
              @input="emit('update:caption', ($event.target as HTMLInputElement).value)"
              @keydown.enter="handleSend"
            />
            <div class="relative">
              <button
                class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac text-white transition-all"
                :class="props.sending ? 'opacity-50' : 'hover:brightness-110'"
                :disabled="props.sending"
                @click="handleSend"
                @contextmenu.prevent="showCaptionMenu = !showCaptionMenu"
              >
                <div v-if="props.sending" class="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
              <!-- Caption position menu -->
              <div
                v-if="showCaptionMenu"
                class="absolute bottom-12 right-0 w-48 overflow-hidden rounded-lg bg-neutral-800 shadow-xl"
              >
                <button
                  class="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-white transition-colors hover:bg-white/10"
                  @click="toggleCaptionPosition"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
                  </svg>
                  {{ props.captionAbove ? "Caption below" : "Caption above" }}
                </button>
              </div>
            </div>
          </div>
          <div v-if="props.caption" class="mt-1 text-right text-xs text-white/40">
            {{ props.caption.length }} / 1024
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.media-preview-enter-active { transition: opacity 0.2s ease; }
.media-preview-leave-active { transition: opacity 0.15s ease; }
.media-preview-enter-from,
.media-preview-leave-to { opacity: 0; }
</style>
```

**Verify:** `npx vite build`

---

### Task 7: Integrate MediaPreview into MessageInput

**Files:**
- Modify: `src/features/messaging/ui/MessageInput.vue`

**Step 1: Import MediaPreview and composable**

Add imports:

```ts
import MediaPreview from "./MediaPreview.vue";
import { useMediaUpload } from "../model/use-media-upload";
```

**Step 2: Initialize composable**

```ts
const mediaUpload = useMediaUpload();
```

**Step 3: Update file selection handlers**

Replace `handleFileSelect` to route photo/video files through MediaPreview:

```ts
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

  // Non-media files go through direct send
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
```

**Step 4: Add media send handler**

```ts
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
        await sendFile(f.file); // video falls back to sendFile for now
      }
    }
  } finally {
    mediaUpload.clear();
  }
};
```

**Step 5: Update template**

Change the photo input `@change` to use `handlePhotoSelect`. Add MediaPreview component at the end:

```html
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
```

Also import `sendImage` from useMessages:
```ts
const { sendMessage, sendFile, sendImage, sendReply, editMessage, setTyping } = useMessages();
```

**Verify:** `npx vite build`

---

## Batch 3: Voice Recording

### Task 8: Install audio-recorder-polyfill

**Step 1: Install dependency**

Run: `npm install audio-recorder-polyfill`

**Verify:** `npx vite build`

---

### Task 9: Create use-voice-recorder composable

**Files:**
- Create: `src/features/messaging/model/use-voice-recorder.ts`

```ts
import { ref } from "vue";
import AudioRecorder from "audio-recorder-polyfill";
import mpegEncoder from "audio-recorder-polyfill/mpeg-encoder";

// Configure MP3 encoder (matching bastyon-chat)
AudioRecorder.encoder = mpegEncoder;
AudioRecorder.prototype.mimeType = "audio/mpeg";

export type RecorderState = "idle" | "recording" | "locked" | "preview";

export function useVoiceRecorder() {
  const state = ref<RecorderState>("idle");
  const duration = ref(0);
  const waveformData = ref<number[]>([]);
  const recordedBlob = ref<Blob | null>(null);

  let mediaRecorder: InstanceType<typeof AudioRecorder> | null = null;
  let audioStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let durationTimer: ReturnType<typeof setInterval> | null = null;
  let waveformTimer: ReturnType<typeof setInterval> | null = null;
  let audioChunks: Blob[] = [];

  /** Compute RMS from frequency data (same as bastyon-chat generateRms) */
  const computeRms = (frequencies: Uint8Array): number => {
    const sum = frequencies.reduce((a, b) => a + b * b, 0);
    return +(Math.sqrt(sum / frequencies.length) / 255).toPrecision(3);
  };

  const startRecording = async () => {
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];

      // Set up analyser for waveform
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(audioStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      // Create recorder (MP3 32kbps)
      mediaRecorder = new AudioRecorder(audioStream, { audioBitsPerSecond: 32000 });

      mediaRecorder.addEventListener("dataavailable", (e: BlobEvent) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      });

      mediaRecorder.start();
      state.value = "recording";
      duration.value = 0;
      waveformData.value = [];

      // Duration timer
      durationTimer = setInterval(() => {
        duration.value++;
      }, 1000);

      // Waveform sampling (every 50ms, keep last 50 samples)
      const freqData = new Uint8Array(analyser.frequencyBinCount);
      waveformTimer = setInterval(() => {
        if (analyser) {
          analyser.getByteFrequencyData(freqData);
          const rms = computeRms(freqData);
          waveformData.value = [...waveformData.value.slice(-49), rms];
        }
      }, 50);
    } catch (e) {
      console.error("Failed to start recording:", e);
      cleanup();
    }
  };

  const cleanup = () => {
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    if (waveformTimer) { clearInterval(waveformTimer); waveformTimer = null; }
    if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    analyser = null;
    mediaRecorder = null;
  };

  /** Stop recording and get blob (used internally) */
  const stopRecorder = (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === "inactive") {
        resolve(null);
        return;
      }
      mediaRecorder.addEventListener("stop", () => {
        const blob = audioChunks.length > 0
          ? new Blob(audioChunks, { type: "audio/mpeg" })
          : null;
        cleanup();
        resolve(blob);
      }, { once: true });
      mediaRecorder.stop();
    });
  };

  /** Get audio duration from blob via AudioContext */
  const getAudioDuration = async (blob: Blob): Promise<number> => {
    try {
      const ctx = new AudioContext();
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      ctx.close();
      return Math.round(buffer.duration);
    } catch {
      return duration.value;
    }
  };

  /** Stop and immediately return blob + metadata for sending */
  const stopAndSend = async (): Promise<{ file: File; duration: number; waveform: number[] } | null> => {
    const blob = await stopRecorder();
    if (!blob || blob.size === 0) {
      state.value = "idle";
      return null;
    }
    const dur = await getAudioDuration(blob);
    if (dur < 1) {
      state.value = "idle";
      return null;
    }
    const waveform = [...waveformData.value];
    state.value = "idle";
    const file = new File([blob], `voice_${Date.now()}.mp3`, { type: "audio/mpeg" });
    return { file, duration: dur, waveform };
  };

  /** Stop recording and enter preview mode */
  const stopAndPreview = async () => {
    const blob = await stopRecorder();
    if (!blob || blob.size === 0) {
      state.value = "idle";
      return;
    }
    recordedBlob.value = blob;
    state.value = "preview";
  };

  /** Send from preview mode */
  const sendPreview = async (): Promise<{ file: File; duration: number; waveform: number[] } | null> => {
    const blob = recordedBlob.value;
    if (!blob) return null;
    const dur = await getAudioDuration(blob);
    const waveform = [...waveformData.value];
    recordedBlob.value = null;
    state.value = "idle";
    const file = new File([blob], `voice_${Date.now()}.mp3`, { type: "audio/mpeg" });
    return { file, duration: dur, waveform };
  };

  const lock = () => {
    if (state.value === "recording") {
      state.value = "locked";
    }
  };

  const cancel = () => {
    audioChunks = [];
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    cleanup();
    recordedBlob.value = null;
    state.value = "idle";
  };

  return {
    state, duration, waveformData, recordedBlob,
    startRecording, stopAndSend, stopAndPreview, sendPreview,
    lock, cancel,
  };
}
```

**Verify:** `npx vite build`

---

### Task 10: Create VoiceRecorder UI component

**Files:**
- Create: `src/features/messaging/ui/VoiceRecorder.vue`

This component replaces the recording UI in MessageInput. It handles the hold-to-record, swipe-to-lock, swipe-to-cancel gestures and live waveform display.

```vue
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { RecorderState } from "../model/use-voice-recorder";

interface Props {
  state: RecorderState;
  duration: number;
  waveformData: number[];
  recordedBlob: Blob | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  start: [];
  stopAndSend: [];
  stopAndPreview: [];
  sendPreview: [];
  lock: [];
  cancel: [];
}>();

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

// Gesture tracking for mic button
const touchStartY = ref(0);
const touchStartX = ref(0);
const isCancelling = ref(false);

const handleTouchStart = (e: TouchEvent) => {
  touchStartY.value = e.touches[0].clientY;
  touchStartX.value = e.touches[0].clientX;
  isCancelling.value = false;
  emit("start");
};

const handleTouchMove = (e: TouchEvent) => {
  if (props.state !== "recording") return;
  const dy = touchStartY.value - e.touches[0].clientY;
  const dx = touchStartX.value - e.touches[0].clientX;

  // Swipe up > 80px = lock
  if (dy > 80) {
    emit("lock");
    return;
  }
  // Swipe left > 130px = cancel
  if (dx > 130) {
    isCancelling.value = true;
  }
};

const handleTouchEnd = () => {
  if (isCancelling.value) {
    emit("cancel");
    isCancelling.value = false;
    return;
  }
  if (props.state === "recording") {
    emit("stopAndSend");
  }
};

// Preview playback
const previewAudio = ref<HTMLAudioElement | null>(null);
const isPlaying = ref(false);

watch(() => props.recordedBlob, (blob) => {
  if (blob) {
    previewAudio.value = new Audio(URL.createObjectURL(blob));
    previewAudio.value.onended = () => { isPlaying.value = false; };
  } else {
    previewAudio.value = null;
    isPlaying.value = false;
  }
});

const togglePreviewPlay = () => {
  if (!previewAudio.value) return;
  if (isPlaying.value) {
    previewAudio.value.pause();
    isPlaying.value = false;
  } else {
    previewAudio.value.play();
    isPlaying.value = true;
  }
};

// Waveform bars for display (normalize to 50 bars)
const waveformBars = computed(() => {
  const data = props.waveformData;
  if (data.length === 0) return Array(30).fill(0.05);
  const last = data.slice(-30);
  while (last.length < 30) last.unshift(0.05);
  return last;
});
</script>

<template>
  <!-- Recording state -->
  <div v-if="state === 'recording'" class="flex items-center gap-3 p-3">
    <span class="text-xs text-text-on-main-bg-color">&lt; Slide to cancel</span>
    <div class="flex flex-1 items-center gap-2">
      <span class="h-2.5 w-2.5 animate-pulse rounded-full bg-color-bad" />
      <span class="text-sm font-medium text-text-color">{{ formatDuration(duration) }}</span>
    </div>
    <!-- Live waveform -->
    <div class="flex h-8 items-end gap-px">
      <div
        v-for="(v, i) in waveformBars"
        :key="i"
        class="w-1 rounded-full bg-color-bg-ac transition-all"
        :style="{ height: `${Math.max(3, v * 32)}px` }"
      />
    </div>
    <!-- Lock hint -->
    <div class="flex flex-col items-center text-text-on-main-bg-color">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    </div>
  </div>

  <!-- Locked state (hands-free) -->
  <div v-else-if="state === 'locked'" class="flex items-center gap-3 p-3">
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-color-bad transition-colors hover:bg-neutral-grad-0"
      @click="emit('cancel')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    </button>
    <div class="flex flex-1 items-center gap-2">
      <span class="h-2.5 w-2.5 animate-pulse rounded-full bg-color-bad" />
      <span class="text-sm font-medium text-text-color">{{ formatDuration(duration) }}</span>
    </div>
    <div class="flex h-8 items-end gap-px">
      <div
        v-for="(v, i) in waveformBars"
        :key="i"
        class="w-1 rounded-full bg-color-bg-ac transition-all"
        :style="{ height: `${Math.max(3, v * 32)}px` }"
      />
    </div>
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-white transition-all hover:brightness-110"
      @click="emit('stopAndPreview')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
    </button>
  </div>

  <!-- Preview state -->
  <div v-else-if="state === 'preview'" class="flex items-center gap-3 p-3">
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-color-bad transition-colors hover:bg-neutral-grad-0"
      @click="emit('cancel')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    </button>
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac transition-colors hover:bg-color-bg-ac/20"
      @click="togglePreviewPlay"
    >
      <svg v-if="!isPlaying" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
      <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
    </button>
    <span class="text-sm text-text-color">{{ formatDuration(duration) }}</span>
    <div class="flex-1" />
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-white transition-all hover:brightness-110"
      @click="emit('sendPreview')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
      </svg>
    </button>
  </div>

  <!-- Idle: mic button (to be placed in MessageInput) -->
  <button
    v-else
    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
    title="Voice message"
    @touchstart.prevent="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
    @mousedown.prevent="emit('start')"
    @mouseup="state === 'recording' ? emit('stopAndSend') : undefined"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  </button>
</template>
```

**Verify:** `npx vite build`

---

### Task 11: Integrate VoiceRecorder into MessageInput

**Files:**
- Modify: `src/features/messaging/ui/MessageInput.vue`

**Step 1:** Remove all existing voice recording code (isRecording, recordingDuration, mediaRecorder, audioChunks, recordingTimer, formatDuration, startRecording, stopRecording, cancelRecording variables and functions).

**Step 2:** Import VoiceRecorder and composable:

```ts
import VoiceRecorder from "./VoiceRecorder.vue";
import { useVoiceRecorder } from "../model/use-voice-recorder";
```

**Step 3:** Initialize:

```ts
const voiceRecorder = useVoiceRecorder();
```

**Step 4:** Add voice send handler:

```ts
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
```

Import `sendAudio` from useMessages.

**Step 5:** Replace the recording bar and mic button in the template:

Replace the entire `<!-- Recording bar -->` section and the mic button at the end of the input row with:

```html
<!-- Voice recorder (replaces recording bar + mic button) -->
<VoiceRecorder
  v-if="voiceRecorder.state.value !== 'idle' || (!text.trim() && !sending)"
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
```

The VoiceRecorder handles both the recording states AND the idle mic button (when state is "idle", it renders just the mic button).

**Verify:** `npx vite build`

---

## Batch 4: Voice Playback

### Task 12: Create VoiceMessage player component

**Files:**
- Create: `src/features/messaging/ui/VoiceMessage.vue`

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import type { FileInfo } from "@/entities/chat";
import { useFileDownload } from "../model/use-file-download";

interface Props {
  messageId: string;
  fileInfo: FileInfo;
  isOwn: boolean;
}

const props = defineProps<Props>();

const { getState, download } = useFileDownload();
const fileState = computed(() => getState(props.messageId));

const audio = ref<HTMLAudioElement | null>(null);
const isPlaying = ref(false);
const currentTime = ref(0);
const playbackRate = ref(1);
const hasListened = ref(false);

const totalDuration = computed(() => props.fileInfo.duration ?? 0);

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const displayTime = computed(() => {
  if (isPlaying.value || currentTime.value > 0) {
    return formatTime(currentTime.value);
  }
  return formatTime(totalDuration.value);
});

// Waveform: use stored data or generate from audio buffer
const waveform = ref<number[]>(props.fileInfo.waveform ?? []);
const BARS = 40;

const normalizedWaveform = computed(() => {
  if (waveform.value.length === 0) return Array(BARS).fill(0.15);
  // Resample to BARS bars
  const src = waveform.value;
  const result: number[] = [];
  for (let i = 0; i < BARS; i++) {
    const idx = Math.floor((i / BARS) * src.length);
    result.push(src[idx] ?? 0.15);
  }
  // Normalize
  const max = Math.max(...result, 0.01);
  return result.map(v => Math.max(0.08, v / max));
});

const progress = computed(() => {
  if (totalDuration.value === 0) return 0;
  return currentTime.value / totalDuration.value;
});

const playedBars = computed(() => Math.floor(progress.value * BARS));

// Generate waveform from audio buffer when no stored data
const generateWaveform = async (url: string) => {
  if (waveform.value.length > 0) return;
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    ctx.close();
    const channelData = buffer.getChannelData(0);
    const samples: number[] = [];
    const step = Math.floor(channelData.length / 50);
    for (let i = 0; i < 50; i++) {
      let sum = 0;
      const start = i * step;
      for (let j = start; j < start + step && j < channelData.length; j++) {
        sum += Math.abs(channelData[j]);
      }
      samples.push(sum / step);
    }
    waveform.value = samples;
  } catch { /* ignore */ }
};

const initAudio = async () => {
  if (!fileState.value.objectUrl) {
    await download({ id: props.messageId, fileInfo: props.fileInfo } as any);
  }
  const url = fileState.value.objectUrl;
  if (!url) return;

  generateWaveform(url);

  audio.value = new Audio(url);
  audio.value.playbackRate = playbackRate.value;

  audio.value.ontimeupdate = () => {
    currentTime.value = audio.value?.currentTime ?? 0;
  };
  audio.value.onended = () => {
    isPlaying.value = false;
    currentTime.value = 0;
  };
};

const togglePlay = async () => {
  if (!audio.value) await initAudio();
  if (!audio.value) return;

  if (isPlaying.value) {
    audio.value.pause();
    isPlaying.value = false;
  } else {
    await audio.value.play();
    isPlaying.value = true;
    hasListened.value = true;
  }
};

const seek = (e: MouseEvent) => {
  if (!audio.value || totalDuration.value === 0) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.value.currentTime = ratio * totalDuration.value;
  currentTime.value = audio.value.currentTime;
};

const cycleSpeed = () => {
  const speeds = [1, 1.5, 2];
  const idx = speeds.indexOf(playbackRate.value);
  playbackRate.value = speeds[(idx + 1) % speeds.length];
  if (audio.value) audio.value.playbackRate = playbackRate.value;
};

onMounted(() => {
  // Auto-download for voice messages
  if (props.fileInfo.url) {
    download({ id: props.messageId, fileInfo: props.fileInfo } as any);
  }
});

onUnmounted(() => {
  if (audio.value) {
    audio.value.pause();
    audio.value = null;
  }
});
</script>

<template>
  <div class="flex items-center gap-2">
    <!-- Play/Pause button -->
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors"
      :class="props.isOwn ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-color-bg-ac/10 text-color-bg-ac hover:bg-color-bg-ac/20'"
      @click="togglePlay"
    >
      <div v-if="fileState.loading" class="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      <svg v-else-if="!isPlaying" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
    </button>

    <!-- Waveform + progress -->
    <div class="flex min-w-0 flex-1 cursor-pointer flex-col gap-1" @click="seek">
      <div class="flex h-6 items-end gap-[2px]">
        <div
          v-for="(v, i) in normalizedWaveform"
          :key="i"
          class="w-[3px] rounded-full transition-colors"
          :class="i < playedBars
            ? (props.isOwn ? 'bg-white' : 'bg-color-bg-ac')
            : (props.isOwn ? 'bg-white/30' : 'bg-color-bg-ac/30')"
          :style="{ height: `${Math.max(3, v * 24)}px` }"
        />
      </div>
      <div class="flex items-center justify-between">
        <span class="text-[11px] tabular-nums" :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
          {{ displayTime }}
        </span>
        <!-- Unlistened dot -->
        <span v-if="!hasListened && !props.isOwn" class="h-2 w-2 rounded-full bg-color-bg-ac" />
      </div>
    </div>

    <!-- Speed button -->
    <button
      class="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums transition-colors"
      :class="props.isOwn ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-color-bg-ac/10 text-color-bg-ac hover:bg-color-bg-ac/20'"
      @click="cycleSpeed"
    >
      {{ playbackRate }}x
    </button>
  </div>
</template>
```

**Verify:** `npx vite build`

---

### Task 13: Integrate VoiceMessage into MessageBubble

**Files:**
- Modify: `src/features/messaging/ui/MessageBubble.vue`

**Step 1:** Import VoiceMessage:

```ts
import VoiceMessage from "./VoiceMessage.vue";
```

**Step 2:** Replace the audio message section in the template.

Find the `<!-- Audio message -->` section (the entire `v-else-if="message.type === MessageType.audio && hasFileInfo"` block).

Replace the inner content (after the forwarded/reply previews) — replace the `<audio>`, play button, and loading spinner with:

```html
<VoiceMessage
  :message-id="message.id"
  :file-info="message.fileInfo!"
  :is-own="props.isOwn"
/>
```

Keep the timestamp and reactions rows below VoiceMessage.

**Verify:** `npx vite build`

---

## Batch 5: Polish

### Task 14: Add upload progress to MessageBubble

In MessageBubble, when `message.status === MessageStatus.sending` and the message has fileInfo, show a small progress overlay. This requires threading progress through the message. For now, show an indeterminate progress indicator on sending media messages.

### Task 15: Update MediaViewer for captions

In MediaViewer, display `message.fileInfo?.caption` at the bottom of the viewer when present.

### Task 16: Update forwardMessage for new msgtypes

In `use-messages.ts`, update `forwardMessage` to handle m.image/m.audio/m.video content format (currently only handles m.file JSON body).

---

## Verification Checklist

After each batch, run `npx vite build` and verify:

1. **Batch 1:** Build passes. FileInfo has new fields. parseFileInfo handles m.audio/m.video.
2. **Batch 2:** MediaPreview opens after photo selection. Caption input works. Images sent as m.image with caption.
3. **Batch 3:** Hold mic to record. Swipe up locks. Swipe left cancels. Release sends. Preview mode in locked state. Voice sent as m.audio MP3.
4. **Batch 4:** Voice messages show waveform player. Play/pause works. Speed switching works. Seek by tap works.
5. **Batch 5:** Progress indicator on uploading messages. Captions in MediaViewer. Forward handles all msgtypes.
