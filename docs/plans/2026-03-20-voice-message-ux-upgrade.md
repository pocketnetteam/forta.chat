# Voice Message UX Upgrade — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade voice message playback to Telegram-level UX: global audio manager, drag-seek, dual time display, auto-chain, double-tap ±5s, and persistent listened state.

**Architecture:** Extract per-component Audio into a singleton `useAudioPlayback` composable (Pinia-like reactive singleton). VoiceMessage.vue becomes a thin UI shell that subscribes to the manager. All seek/play/pause logic lives in the manager. The waveform stays in VoiceMessage but gains pointer-based drag seeking.

**Tech Stack:** Vue 3 Composition API, TypeScript, Pinia, Dexie (local DB for listened state), HTML5 Audio API, Pointer Events API.

---

## Task 1: Create `useAudioPlayback` global singleton composable

**Files:**
- Create: `src/features/messaging/model/use-audio-playback.ts`

**Why:** Currently each VoiceMessage creates its own HTMLAudioElement. This prevents: coordinated pause when a new message plays, auto-chain to next unlistened, persistent state across scroll. A singleton solves all three.

**Step 1: Create the composable file**

```ts
// src/features/messaging/model/use-audio-playback.ts
import { ref, computed, shallowRef } from "vue";

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "ended" | "failed";

interface PlaybackInfo {
  messageId: string;
  roomId: string;
  objectUrl: string;
  duration: number;
}

// Singleton state — shared across all components
const audio = shallowRef<HTMLAudioElement | null>(null);
const state = ref<PlaybackState>("idle");
const currentMessageId = ref<string | null>(null);
const currentRoomId = ref<string | null>(null);
const currentTime = ref(0);
const duration = ref(0);
const playbackRate = ref(1);

// Callback for auto-chain: set by VoiceMessage's parent context
let onEndedCallback: ((messageId: string, roomId: string) => void) | null = null;

function cleanup() {
  if (audio.value) {
    audio.value.pause();
    audio.value.removeAttribute("src");
    audio.value.load();
  }
  audio.value = null;
  state.value = "idle";
  currentMessageId.value = null;
  currentRoomId.value = null;
  currentTime.value = 0;
  duration.value = 0;
}

function setupAudioListeners(el: HTMLAudioElement) {
  el.ontimeupdate = () => {
    currentTime.value = el.currentTime;
  };
  el.onended = () => {
    const msgId = currentMessageId.value;
    const roomId = currentRoomId.value;
    state.value = "ended";
    currentTime.value = 0;
    if (msgId && roomId && onEndedCallback) {
      onEndedCallback(msgId, roomId);
    }
  };
  el.onerror = () => {
    state.value = "failed";
  };
  el.onloadedmetadata = () => {
    duration.value = el.duration;
  };
}

export function useAudioPlayback() {
  const isActive = (messageId: string) =>
    computed(() => currentMessageId.value === messageId);

  const isPlaying = (messageId: string) =>
    computed(() => currentMessageId.value === messageId && state.value === "playing");

  const progress = computed(() => {
    if (duration.value === 0) return 0;
    return currentTime.value / duration.value;
  });

  async function play(info: PlaybackInfo) {
    // If same message and paused — resume
    if (currentMessageId.value === info.messageId && audio.value && state.value === "paused") {
      await audio.value.play();
      state.value = "playing";
      return;
    }

    // If same message and ended — replay from start
    if (currentMessageId.value === info.messageId && audio.value && state.value === "ended") {
      audio.value.currentTime = 0;
      await audio.value.play();
      state.value = "playing";
      return;
    }

    // New message — stop current and start new
    cleanup();
    state.value = "loading";
    currentMessageId.value = info.messageId;
    currentRoomId.value = info.roomId;
    duration.value = info.duration;

    try {
      const el = new Audio(info.objectUrl);
      el.playbackRate = playbackRate.value;
      setupAudioListeners(el);
      audio.value = el;
      await el.play();
      state.value = "playing";
    } catch {
      state.value = "failed";
    }
  }

  function pause() {
    if (audio.value && state.value === "playing") {
      audio.value.pause();
      state.value = "paused";
    }
  }

  function togglePlay(info: PlaybackInfo) {
    if (currentMessageId.value === info.messageId && state.value === "playing") {
      pause();
    } else {
      play(info);
    }
  }

  function seek(time: number) {
    if (audio.value) {
      audio.value.currentTime = Math.max(0, Math.min(time, duration.value));
      currentTime.value = audio.value.currentTime;
    }
  }

  function seekByRatio(ratio: number) {
    seek(ratio * duration.value);
  }

  function skipForward(seconds = 5) {
    if (audio.value) {
      seek(audio.value.currentTime + seconds);
    }
  }

  function skipBackward(seconds = 5) {
    if (audio.value) {
      seek(audio.value.currentTime - seconds);
    }
  }

  function cycleSpeed() {
    const speeds = [1, 1.5, 2];
    const idx = speeds.indexOf(playbackRate.value);
    playbackRate.value = speeds[(idx + 1) % speeds.length];
    if (audio.value) {
      audio.value.playbackRate = playbackRate.value;
    }
  }

  function setOnEnded(cb: (messageId: string, roomId: string) => void) {
    onEndedCallback = cb;
  }

  function stop() {
    cleanup();
  }

  return {
    // Reactive state (read-only for consumers)
    state,
    currentMessageId,
    currentRoomId,
    currentTime,
    duration,
    playbackRate,
    progress,

    // Queries
    isActive,
    isPlaying,

    // Actions
    play,
    pause,
    togglePlay,
    seek,
    seekByRatio,
    skipForward,
    skipBackward,
    cycleSpeed,
    setOnEnded,
    stop,
  };
}
```

**Step 2: Verify build**

Run: `cd /Users/daniilkim/work/new-bastyon-chat && npx vite build 2>&1 | tail -5`
Expected: Build succeeds (new file is unused, no errors)

**Step 3: Commit**

```bash
git add src/features/messaging/model/use-audio-playback.ts
git commit -m "feat(voice): add global AudioPlayback singleton composable

Single HTMLAudioElement across all voice messages. Supports play/pause/seek/speed/auto-chain callback."
```

---

## Task 2: Add persistent `listenedMessages` to Dexie local DB

**Files:**
- Modify: `src/shared/lib/local-db/schema.ts`
- Create: `src/shared/lib/local-db/listened-repository.ts`

**Why:** Currently `hasListened` is a local ref that resets on page reload. Users lose the "unlistened" dot state. Store listened message IDs in Dexie so it persists.

**Step 1: Check current schema**

Read `src/shared/lib/local-db/schema.ts` to find the Dexie DB version and tables.

**Step 2: Add `listenedMessages` table to schema**

Add to the existing DB version (or bump if needed):

```ts
// In the schema definition, add:
listenedMessages: "messageId"
```

This is a simple key-value store: `{ messageId: string }`.

**Step 3: Create listened-repository.ts**

```ts
// src/shared/lib/local-db/listened-repository.ts
import { db } from "./schema";

/** Mark a voice message as listened */
export async function markListened(messageId: string): Promise<void> {
  await db.table("listenedMessages").put({ messageId });
}

/** Check if a message has been listened to */
export async function isListened(messageId: string): Promise<boolean> {
  const row = await db.table("listenedMessages").get(messageId);
  return !!row;
}

/** Batch check: returns Set of listened message IDs */
export async function getListenedSet(messageIds: string[]): Promise<Set<string>> {
  const rows = await db.table("listenedMessages").where("messageId").anyOf(messageIds).toArray();
  return new Set(rows.map((r: { messageId: string }) => r.messageId));
}
```

**Step 4: Verify build**

Run: `cd /Users/daniilkim/work/new-bastyon-chat && npx vite build 2>&1 | tail -5`

**Step 5: Commit**

```bash
git add src/shared/lib/local-db/schema.ts src/shared/lib/local-db/listened-repository.ts
git commit -m "feat(voice): persistent listened state in Dexie

Store listened voice message IDs so unlistened dot survives page reloads."
```

---

## Task 3: Rewrite VoiceMessage.vue to use global AudioPlayback + drag seek

**Files:**
- Modify: `src/features/messaging/ui/VoiceMessage.vue`

**Why:** This is the core UX upgrade — replacing per-component Audio with the global manager, adding drag-seek via pointer events, showing dual time, and integrating persistent listened state.

**Step 1: Rewrite the full component**

Replace the entire `<script setup>` and `<template>` of `VoiceMessage.vue`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import type { Message } from "@/entities/chat";
import { useFileDownload } from "../model/use-file-download";
import { useAudioPlayback } from "../model/use-audio-playback";
import { markListened, isListened } from "@/shared/lib/local-db/listened-repository";

interface Props {
  message: Message;
  isOwn: boolean;
}

const props = defineProps<Props>();

const { getState, download } = useFileDownload();
const fileState = computed(() => getState(props.message.id));

const playback = useAudioPlayback();

const hasListened = ref(false);
const isSeeking = ref(false);
const seekRatio = ref(0);
const lastDoubleTapSide = ref<"left" | "right" | null>(null);
const doubleTapTimer = ref<ReturnType<typeof setTimeout> | null>(null);

// Load persisted listened state
onMounted(async () => {
  if (!props.isOwn) {
    hasListened.value = await isListened(props.message.id);
  }
});

const totalDuration = computed(() => props.message.fileInfo?.duration ?? 0);

const isActive = playback.isActive(props.message.id);
const isMessagePlaying = playback.isPlaying(props.message.id);

const currentTime = computed(() => {
  if (!isActive.value) return 0;
  return playback.currentTime.value;
});

const progress = computed(() => {
  if (isSeeking.value) return seekRatio.value;
  if (!isActive.value) return 0;
  if (totalDuration.value === 0) return 0;
  return currentTime.value / totalDuration.value;
});

const playedBars = computed(() => Math.floor(progress.value * BARS));

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

// Dual time: "current / total" when playing/paused, just "total" when idle
const displayTime = computed(() => {
  if (isActive.value && playback.state.value !== "ended" && playback.state.value !== "idle") {
    return `${formatTime(currentTime.value)} / ${formatTime(totalDuration.value)}`;
  }
  return formatTime(totalDuration.value);
});

// Show speed badge when active (playing or paused)
const showSpeed = computed(() =>
  isActive.value && (playback.state.value === "playing" || playback.state.value === "paused")
);

// Waveform
const waveform = ref<number[]>(props.message.fileInfo?.waveform ?? []);
const BARS = 40;

const normalizedWaveform = computed(() => {
  if (waveform.value.length === 0) return Array(BARS).fill(0.15);
  const src = waveform.value;
  const result: number[] = [];
  for (let i = 0; i < BARS; i++) {
    const idx = Math.floor((i / BARS) * src.length);
    result.push(src[idx] ?? 0.15);
  }
  const max = Math.max(...result, 0.01);
  return result.map(v => Math.max(0.08, v / max));
});

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

// ── Play / Pause ──
const handleTogglePlay = async () => {
  // Ensure file is downloaded
  if (!fileState.value.objectUrl) {
    await download(props.message);
  }
  const url = fileState.value.objectUrl;
  if (!url) return;

  generateWaveform(url);

  playback.togglePlay({
    messageId: props.message.id,
    roomId: props.message.roomId,
    objectUrl: url,
    duration: totalDuration.value,
  });

  // Mark as listened on first play
  if (!hasListened.value && !props.isOwn) {
    hasListened.value = true;
    markListened(props.message.id);
  }
};

// ── Drag seek via Pointer Events ──
const waveformRef = ref<HTMLElement | null>(null);

const getRatioFromEvent = (e: PointerEvent): number => {
  if (!waveformRef.value) return 0;
  const rect = waveformRef.value.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
};

const onPointerDown = async (e: PointerEvent) => {
  // Ensure file is downloaded for seek
  if (!fileState.value.objectUrl) {
    await download(props.message);
  }
  const url = fileState.value.objectUrl;
  if (!url) return;

  // If not active, start playback first
  if (!isActive.value) {
    generateWaveform(url);
    await playback.play({
      messageId: props.message.id,
      roomId: props.message.roomId,
      objectUrl: url,
      duration: totalDuration.value,
    });
    if (!hasListened.value && !props.isOwn) {
      hasListened.value = true;
      markListened(props.message.id);
    }
  }

  isSeeking.value = true;
  seekRatio.value = getRatioFromEvent(e);
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
};

const onPointerMove = (e: PointerEvent) => {
  if (!isSeeking.value) return;
  seekRatio.value = getRatioFromEvent(e);
};

const onPointerUp = (e: PointerEvent) => {
  if (!isSeeking.value) return;
  isSeeking.value = false;
  const ratio = getRatioFromEvent(e);
  playback.seekByRatio(ratio);
};

// ── Double-tap ±5s ──
let lastTapTime = 0;
const DOUBLE_TAP_THRESHOLD = 300; // ms

const handleWaveformClick = (e: MouseEvent) => {
  const now = Date.now();
  if (now - lastTapTime < DOUBLE_TAP_THRESHOLD && isActive.value) {
    // Double tap detected
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const isLeft = x < rect.width / 2;

    if (isLeft) {
      playback.skipBackward(5);
      lastDoubleTapSide.value = "left";
    } else {
      playback.skipForward(5);
      lastDoubleTapSide.value = "right";
    }

    // Clear indicator after animation
    if (doubleTapTimer.value) clearTimeout(doubleTapTimer.value);
    doubleTapTimer.value = setTimeout(() => {
      lastDoubleTapSide.value = null;
    }, 600);
  }
  lastTapTime = now;
};

// Speed control
const handleCycleSpeed = () => {
  playback.cycleSpeed();
};
</script>

<template>
  <div class="flex items-center gap-2">
    <!-- Play/Pause button -->
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors"
      :class="props.isOwn ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-color-bg-ac/10 text-color-bg-ac hover:bg-color-bg-ac/20'"
      @click="handleTogglePlay"
    >
      <div v-if="fileState.loading" class="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      <svg v-else-if="!isMessagePlaying" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
    </button>

    <!-- Waveform + progress -->
    <div
      ref="waveformRef"
      class="relative flex min-w-0 flex-1 cursor-pointer flex-col gap-1 select-none touch-none"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @click="handleWaveformClick"
    >
      <!-- Double-tap indicator -->
      <Transition name="fade">
        <div
          v-if="lastDoubleTapSide"
          class="pointer-events-none absolute inset-0 z-10 flex items-center"
          :class="lastDoubleTapSide === 'left' ? 'justify-start pl-2' : 'justify-end pr-2'"
        >
          <span class="rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-bold text-white">
            {{ lastDoubleTapSide === 'left' ? '« 5s' : '5s »' }}
          </span>
        </div>
      </Transition>

      <div class="flex h-6 items-end gap-[2px]">
        <div
          v-for="(v, i) in normalizedWaveform"
          :key="i"
          class="w-[3px] rounded-full transition-colors duration-100"
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
        <Transition name="fade">
          <span v-if="!hasListened && !props.isOwn" class="h-2 w-2 rounded-full bg-color-bg-ac" />
        </Transition>
      </div>
    </div>

    <!-- Speed button (visible when active) -->
    <button
      v-if="showSpeed"
      class="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums transition-colors"
      :class="props.isOwn ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-color-bg-ac/10 text-color-bg-ac hover:bg-color-bg-ac/20'"
      @click="handleCycleSpeed"
    >
      {{ playback.playbackRate.value }}x
    </button>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
```

**Step 2: Verify build**

Run: `cd /Users/daniilkim/work/new-bastyon-chat && npx vite build 2>&1 | tail -5`

**Step 3: Commit**

```bash
git add src/features/messaging/ui/VoiceMessage.vue
git commit -m "feat(voice): rewrite VoiceMessage with global playback + drag seek

- Uses AudioPlayback singleton instead of per-component Audio
- Drag seek via pointer events (touch + mouse unified)
- Dual time display: current / total
- Double-tap ±5s skip with visual indicator
- Persistent listened state via Dexie
- Speed badge only shown when active"
```

---

## Task 4: Add auto-chain playback (play next unlistened voice message)

**Files:**
- Modify: `src/features/messaging/ui/VoiceMessage.vue` (register onEnded callback)
- Modify: `src/features/messaging/model/use-audio-playback.ts` (already has onEndedCallback hook)
- Modify: `src/widgets/chat-window/ChatWindow.vue` or the messages list component — wherever the list of messages is iterated

**Why:** When a voice message ends, Telegram auto-plays the next unlistened voice message in the chat. This requires coordination at the chat level, not the individual message level.

**Step 1: Find where messages are rendered**

Read `src/widgets/chat-window/ChatWindow.vue` and find the messages iteration loop. The auto-chain logic should live at this level because it has access to the full message list.

**Step 2: Add auto-chain setup in the chat window**

At the chat-window level (or a parent composable), set up the auto-chain callback:

```ts
import { useAudioPlayback } from "@/features/messaging/model/use-audio-playback";
import { useChatStore } from "@/entities/chat";
import { isListened } from "@/shared/lib/local-db/listened-repository";
import { useFileDownload } from "@/features/messaging/model/use-file-download";

const playback = useAudioPlayback();
const chatStore = useChatStore();
const { getState, download } = useFileDownload();

// Auto-chain: when a voice message ends, find and play the next unlistened one
playback.setOnEnded(async (endedMessageId: string, roomId: string) => {
  const messages = chatStore.activeMessages; // or however messages are accessed
  const audioMessages = messages.filter(m => m.type === MessageType.audio);

  // Find current message index
  const currentIdx = audioMessages.findIndex(m => m.id === endedMessageId);
  if (currentIdx === -1) return;

  // Look for next unlistened voice message (chronologically after)
  for (let i = currentIdx + 1; i < audioMessages.length; i++) {
    const next = audioMessages[i];
    const listened = await isListened(next.id);
    if (!listened) {
      // Download if needed
      let url = getState(next.id).objectUrl;
      if (!url) {
        const result = await download(next);
        url = result ?? null;
      }
      if (url) {
        playback.play({
          messageId: next.id,
          roomId: next.roomId,
          objectUrl: url,
          duration: next.fileInfo?.duration ?? 0,
        });
      }
      return;
    }
  }
  // No next unlistened — stop (already in "ended" state)
});
```

**Step 3: Verify build**

Run: `cd /Users/daniilkim/work/new-bastyon-chat && npx vite build 2>&1 | tail -5`

**Step 4: Manual test**

1. Open a chat with multiple voice messages
2. Play the first voice message
3. When it ends, verify the next unlistened voice message starts automatically
4. When all are listened, verify playback stops

**Step 5: Commit**

```bash
git add src/widgets/chat-window/ChatWindow.vue
git commit -m "feat(voice): auto-chain plays next unlistened voice message

When a voice message ends, automatically starts the next unlistened
voice message in the same chat. Stops when all are listened."
```

---

## Task 5: Update VoiceList.vue (chat info panel) to use global playback

**Files:**
- Modify: `src/features/chat-info/ui/VoiceList.vue`

**Why:** VoiceList has its own parallel audio management (`playingId`, `audioEl`). It should use the same global `useAudioPlayback` so that playing a voice from the info panel correctly coordinates with the chat view.

**Step 1: Rewrite VoiceList to use useAudioPlayback**

Replace the local `playingId`/`audioEl` logic with the global playback manager:

```vue
<script setup lang="ts">
import type { Message } from "@/entities/chat/model/types";
import { useAuthStore } from "@/entities/auth";
import { useFileDownload } from "@/features/messaging/model/use-file-download";
import { useAudioPlayback } from "@/features/messaging/model/use-audio-playback";
import { formatDate } from "@/shared/lib/format";

const props = defineProps<{
  messages: Message[];
}>();

const emit = defineEmits<{
  contextmenu: [payload: { message: Message; x: number; y: number }];
}>();

const { t } = useI18n();
const authStore = useAuthStore();
const { getState, download } = useFileDownload();
const playback = useAudioPlayback();

// Month grouping (keep existing logic)
interface MonthGroup {
  label: string;
  messages: Message[];
}

const grouped = computed<MonthGroup[]>(() => {
  const groups: MonthGroup[] = [];
  let currentLabel = "";
  let currentGroup: Message[] = [];
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

function getSenderName(address: string): string {
  return authStore.getBastyonUserData(address)?.name || address.slice(0, 10);
}

const togglePlay = async (msg: Message) => {
  // Ensure downloaded
  let url = getState(msg.id).objectUrl;
  if (!url) {
    const result = await download(msg);
    url = result ?? null;
  }
  if (!url) return;

  playback.togglePlay({
    messageId: msg.id,
    roomId: msg.roomId,
    objectUrl: url,
    duration: msg.fileInfo?.duration ?? 0,
  });
};

// No need for onUnmounted cleanup — the global manager handles it
</script>
```

The template stays the same, but replace `playingId === msg.id` with `playback.isPlaying(msg.id).value`:

```html
<!-- In the template, replace: -->
<!-- playingId === msg.id → playback.isPlaying(msg.id).value -->
<svg v-else-if="playback.isPlaying(msg.id).value" ...>
```

**Step 2: Verify build**

Run: `cd /Users/daniilkim/work/new-bastyon-chat && npx vite build 2>&1 | tail -5`

**Step 3: Commit**

```bash
git add src/features/chat-info/ui/VoiceList.vue
git commit -m "refactor(voice): VoiceList uses global AudioPlayback

Remove local audio element management. Playing a voice from chat info
now correctly coordinates with the main chat view."
```

---

## Task 6: Cleanup and stop audio on route change / chat switch

**Files:**
- Modify: `src/widgets/chat-window/ChatWindow.vue` (or wherever activeRoomId is watched)

**Why:** If the user switches to another chat while a voice is playing, it should keep playing (like Telegram). But when navigating away from chat entirely, stop playback.

**Step 1: Add watcher for room changes**

```ts
// In ChatWindow or the component that manages chat navigation:
import { useAudioPlayback } from "@/features/messaging/model/use-audio-playback";

const playback = useAudioPlayback();

// Option A: Let voice play across chats (Telegram behavior)
// No action needed on room switch — audio continues

// Option B: Stop on navigation away from all chats
onUnmounted(() => {
  // Only stop if we're truly leaving the chat area
  // The singleton persists, so this is safe
});
```

Actually, for Phase 1 the simplest correct behavior is: audio keeps playing across chat switches (Telegram-like). The global manager already handles this. We just need to ensure that when the app is backgrounded or the tab is hidden, we don't interfere.

**Step 2: Commit (if any changes were needed)**

```bash
git commit -m "feat(voice): audio persists across chat switches"
```

---

## Task 7: Final integration test and polish

**Files:**
- All modified files

**Step 1: Full manual testing checklist**

1. **Play/Pause:** Tap play → audio starts, button changes to pause. Tap pause → audio pauses.
2. **Drag seek:** Drag finger/mouse along waveform → audio position updates in real-time.
3. **Tap seek:** Tap on waveform → jumps to position.
4. **Double-tap skip:** Double-tap left half → -5s. Double-tap right half → +5s. Visual indicator shows.
5. **Dual time:** While playing, shows `0:12 / 0:34`. While idle, shows `0:34`.
6. **Speed cycling:** Tap speed badge → cycles 1x → 1.5x → 2x → 1x.
7. **Single playback:** Play message A, then play message B → A pauses, B plays.
8. **Auto-chain:** Play unlistened voice → when it ends, next unlistened starts automatically.
9. **Listened persistence:** Play a voice, reload page → blue dot is gone.
10. **VoiceList panel:** Play from chat info panel → same global playback, no conflicts.
11. **Chat switch:** Switch to another chat while voice plays → audio continues.

**Step 2: Fix any issues found**

**Step 3: Final commit**

```bash
git add -A
git commit -m "fix(voice): integration fixes from testing"
```

---

## Summary of files changed

| File | Action | Purpose |
|------|--------|---------|
| `src/features/messaging/model/use-audio-playback.ts` | Create | Global singleton audio manager |
| `src/shared/lib/local-db/schema.ts` | Modify | Add `listenedMessages` table |
| `src/shared/lib/local-db/listened-repository.ts` | Create | Dexie CRUD for listened state |
| `src/features/messaging/ui/VoiceMessage.vue` | Rewrite | New UX: drag seek, dual time, double-tap, global playback |
| `src/features/chat-info/ui/VoiceList.vue` | Modify | Use global playback instead of local audio |
| `src/widgets/chat-window/ChatWindow.vue` | Modify | Auto-chain callback setup |

## Dependencies between tasks

```
Task 1 (AudioPlayback) ──┐
                          ├── Task 3 (VoiceMessage rewrite) ── Task 4 (auto-chain)
Task 2 (Dexie listened) ──┘                                        │
                                                                    ├── Task 7 (test)
                                                        Task 5 (VoiceList) ──┘
                                                        Task 6 (cleanup) ────┘
```

Tasks 1 & 2 can run in parallel. Task 3 depends on both. Tasks 4, 5, 6 depend on 3. Task 7 is last.
