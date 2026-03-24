<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import type { Message } from "@/entities/chat";
import { useFileDownload } from "../model/use-file-download";
import { useAudioPlayback } from "../model/use-audio-playback";
import { getChatDb } from "@/shared/lib/local-db";

interface Props {
  message: Message;
  isOwn: boolean;
}

const props = defineProps<Props>();

const { getState, download } = useFileDownload();
const fileState = computed(() => getState(props.message.id));

const playback = useAudioPlayback();

const active = playback.isActive(props.message.id);
const playing = playback.isPlaying(props.message.id);

const hasListened = ref(false);

// Check persistent listened state on mount
onMounted(async () => {
  if (props.message.fileInfo?.url) {
    download(props.message);
  }
  try {
    hasListened.value = await getChatDb().listened.isListened(props.message.id);
  } catch { /* DB not ready — treat as not listened */ }
});

// Mark as listened when playback starts for this message
watch(playing, (isPlaying) => {
  if (isPlaying && !hasListened.value) {
    hasListened.value = true;
    getChatDb().listened.markListened(props.message.id).catch(() => {});
  }
});

const totalDuration = computed(() => props.message.fileInfo?.duration ?? 0);

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const displayTime = computed(() => {
  if (!active.value) return formatTime(totalDuration.value);
  return `${formatTime(playback.currentTime.value)} / ${formatTime(totalDuration.value)}`;
});

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

const currentProgress = computed(() => {
  if (!active.value) return 0;
  if (totalDuration.value === 0) return 0;
  return playback.currentTime.value / totalDuration.value;
});

const playedBars = computed(() => Math.floor(currentProgress.value * BARS));

// Generate waveform from audio buffer when no stored data
const generateWaveform = async (url: string) => {
  if (waveform.value.length > 0) return;
  const ctx = new AudioContext();
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
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
  } catch { /* ignore */ } finally {
    ctx.close();
  }
};

// Toggle playback — MUST be synchronous from click to .play() to preserve
// the user gesture chain on mobile WebViews. The file is preloaded on mount
// (line 27-29), so objectUrl should be available by the time user taps play.
// If not yet ready, we kick off the download and return — user taps again.
const handleTogglePlay = () => {
  const url = fileState.value.objectUrl;
  if (!url) {
    // File not yet downloaded — trigger download (already started on mount,
    // this handles edge cases where mount download failed or was slow)
    download(props.message);
    return;
  }

  // Synchronous call — no await between click event and .play()
  playback.togglePlay({
    messageId: props.message.id,
    roomId: props.message.roomId,
    objectUrl: url,
    duration: totalDuration.value,
  });

  // Generate waveform in background (non-blocking)
  generateWaveform(url);
};

// Drag-seek via pointer events
const isDragging = ref(false);
const waveformEl = ref<HTMLElement | null>(null);

const getRatioFromPointer = (e: PointerEvent): number => {
  if (!waveformEl.value) return 0;
  const rect = waveformEl.value.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
};

const onPointerDown = (e: PointerEvent) => {
  if (!active.value) return;
  isDragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  playback.seekByRatio(getRatioFromPointer(e));
};

const onPointerMove = (e: PointerEvent) => {
  if (!isDragging.value) return;
  playback.seekByRatio(getRatioFromPointer(e));
};

const onPointerUp = () => {
  isDragging.value = false;
};

// Double-tap skip +/-5s
const skipIndicator = ref<"fwd" | "bwd" | null>(null);
let skipTimeout: ReturnType<typeof setTimeout> | null = null;
let lastTapTime = 0;
let lastTapX = 0;

const onDoubleTap = (e: PointerEvent) => {
  if (!active.value) return;
  const now = Date.now();
  if (now - lastTapTime < 350) {
    // Double tap detected
    if (!waveformEl.value) return;
    const rect = waveformEl.value.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    if (lastTapX < mid && e.clientX < mid) {
      playback.skipBackward(5);
      showSkipIndicator("bwd");
    } else if (lastTapX >= mid && e.clientX >= mid) {
      playback.skipForward(5);
      showSkipIndicator("fwd");
    }
    lastTapTime = 0;
  } else {
    lastTapTime = now;
    lastTapX = e.clientX;
  }
};

const showSkipIndicator = (dir: "fwd" | "bwd") => {
  if (skipTimeout) clearTimeout(skipTimeout);
  skipIndicator.value = dir;
  skipTimeout = setTimeout(() => {
    skipIndicator.value = null;
  }, 600);
};

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
      <svg v-else-if="!playing" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
    </button>

    <!-- Waveform + progress -->
    <div
      ref="waveformEl"
      class="relative flex min-w-0 flex-1 cursor-pointer touch-none select-none flex-col gap-1"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @click="onDoubleTap"
    >
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

      <!-- Skip indicator -->
      <Transition name="fade">
        <div
          v-if="skipIndicator"
          class="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span
            class="rounded-full px-2 py-0.5 text-[10px] font-bold"
            :class="props.isOwn ? 'bg-white/30 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
          >
            {{ skipIndicator === 'fwd' ? '+5s' : '-5s' }}
          </span>
        </div>
      </Transition>

      <div class="flex items-center justify-between">
        <span class="text-[11px] tabular-nums" :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
          {{ displayTime }}
        </span>
        <!-- Unlistened dot -->
        <span v-if="!hasListened && !props.isOwn" class="h-2 w-2 rounded-full bg-color-bg-ac" />
      </div>
    </div>

    <!-- Speed button — only shown when active -->
    <button
      v-if="active"
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
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
