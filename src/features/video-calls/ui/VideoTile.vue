<script setup lang="ts">
import { UserAvatar } from "@/entities/user";

interface Props {
  stream: MediaStream | null;
  muted?: boolean;
  videoOff?: boolean;
  audioOff?: boolean;
  label?: string;
  address?: string;
  objectFit?: "cover" | "contain";
  mirror?: boolean;
  pinnable?: boolean;
  tileId?: string;
  active?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  muted: false,
  videoOff: false,
  audioOff: false,
  label: "",
  address: "",
  objectFit: "cover",
  mirror: false,
  pinnable: false,
  tileId: "",
  active: false,
});

const emit = defineEmits<{
  pin: [tileId: string];
  // Natural aspect ratio (width / height) of the bound stream, emitted once
  // metadata is known and again on track resize. Lets a parent size its
  // container to the source so a `cover` thumbnail no longer crops the frame
  // (forta-bugs#433 / WEE-53 — self-preview PiP).
  aspectchange: [ratio: number];
}>();

const videoRef = ref<HTMLVideoElement | null>(null);

function bindStream(el: HTMLVideoElement | null, stream: MediaStream | null) {
  if (!el || el.srcObject === stream) return;
  el.srcObject = stream;
}

watch(
  () => props.stream,
  (stream) => {
    bindStream(videoRef.value, stream);
    // Reset captured aspect; new stream needs a fresh `loadedmetadata`
    // before the wrapper can reshape. Without this the desktop side kept
    // the previous voice-only aspect after the phone enabled its camera
    // mid-call and the user saw a stretched/dot remote tile (WEE-45).
    //
    // We deliberately do NOT re-emit `aspectchange` here. A parent sizing a
    // container from the ratio (the self-view PiP, WEE-53) keeps the prior
    // aspect until the new stream's `loadedmetadata` fires a fresh value —
    // typically within a frame or two. Emitting a reset would force a size
    // blip to the fallback on every swap, including front↔back camera flips
    // where the ratio is usually identical; persisting is the calmer choice.
    videoAspect.value = null;
  },
  { flush: "post" },
);

onMounted(() => {
  bindStream(videoRef.value, props.stream);
});

const showAvatar = computed(() => props.videoOff || !props.stream);

// WEE-45 — Google-Meet-style adaptive aspect. When the source is portrait
// (phone camera held vertically) and the container is landscape (desktop),
// plain `object-fit: contain` letterboxes the video into a narrow vertical
// strip in the middle — users described this as "точка" / "тонкая полоска".
// Capturing the natural aspect from the actual track and applying it to a
// max-bounded video element produces an inset that hugs the picture
// regardless of orientation, matching the Meet/Zoom behaviour the user
// expects. Only kicks in when `objectFit === 'contain'`; the local PiP
// (cover) still fills its tile.
const videoAspect = ref<number | null>(null);

function captureAspect() {
  const v = videoRef.value;
  if (!v) return;
  const w = v.videoWidth;
  const h = v.videoHeight;
  if (w > 0 && h > 0) {
    videoAspect.value = w / h;
    emit("aspectchange", w / h);
  }
}

const adaptiveStyle = computed<Record<string, string>>(() => {
  // Cover mode (local PiP) — keep full-fill behaviour, no aspect override.
  if (props.objectFit !== "contain") return {};
  if (videoAspect.value === null) return {};
  return {
    aspectRatio: String(videoAspect.value),
    maxWidth: "100%",
    maxHeight: "100%",
    width: "auto",
    height: "auto",
  };
});

const wrapperFlexClass = computed(() =>
  props.objectFit === "contain" ? "flex items-center justify-center" : "",
);

function handleClick() {
  if (props.pinnable && props.tileId) {
    emit("pin", props.tileId);
  }
}
</script>

<template>
  <div
    class="video-tile relative overflow-hidden rounded-xl"
    :class="[
      wrapperFlexClass,
      {
        'cursor-pointer': pinnable,
        'video-tile--active': active,
      },
    ]"
    @click="handleClick"
  >
    <!-- Video element. For `contain` mode the element auto-shrinks to the
         captured aspect-ratio (Google-Meet-style adaptive) so portrait
         sources render as tall and landscape sources render as wide,
         instead of being letterboxed inside a fixed-shape container. -->
    <video
      ref="videoRef"
      :class="{
        'h-full w-full object-cover': objectFit === 'cover',
        'object-contain': objectFit === 'contain',
        'h-full w-full': objectFit === 'contain' && videoAspect === null,
        'scale-x-[-1]': mirror,
        invisible: showAvatar,
      }"
      :style="adaptiveStyle"
      autoplay
      playsinline
      :muted="muted"
      @loadedmetadata="captureAspect"
      @resize="captureAspect"
    />

    <!-- Avatar overlay when video is off or no stream -->
    <Transition name="avatar-fade">
      <div
        v-if="showAvatar"
        class="absolute inset-0 flex items-center justify-center bg-[#1e1e26]"
      >
        <UserAvatar
          v-if="address"
          :address="address"
          size="lg"
        />
        <div
          v-else
          class="flex h-14 w-14 items-center justify-center rounded-full bg-white/10"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-white/40">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        </div>
      </div>
    </Transition>

    <!-- Bottom label bar (frosted glass) -->
    <div
      v-if="label"
      class="label-bar absolute inset-x-0 bottom-0 px-2.5 pb-2 pt-6"
    >
      <div class="flex items-center gap-1.5">
        <!-- Muted mic icon -->
        <svg
          v-if="audioOff"
          class="h-3 w-3 shrink-0 text-red-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
          <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17" />
        </svg>
        <span class="truncate text-[11px] font-medium text-white/85 drop-shadow-sm">{{ label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.video-tile {
  background: #16161c;
  transition: box-shadow 0.2s ease;
}
.video-tile--active {
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.7), 0 0 12px rgba(59, 130, 246, 0.2);
}
.video-tile--active:hover {
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.9), 0 0 16px rgba(59, 130, 246, 0.3);
}

/* ── Label bar frosted glass ── */
.label-bar {
  background: linear-gradient(to top, rgba(0, 0, 0, 0.6) 0%, transparent 100%);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.avatar-fade-enter-active,
.avatar-fade-leave-active {
  transition: opacity 0.3s ease;
}
.avatar-fade-enter-from,
.avatar-fade-leave-to {
  opacity: 0;
}
</style>
