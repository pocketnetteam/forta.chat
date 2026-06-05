<script setup lang="ts">
import { parseVideoUrl, fetchPeerTubeThumb } from "@/shared/lib/video-embed";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
import { isNative } from "@/shared/lib/platform";
import { openExternalUrl } from "@/shared/lib/open-external-url";

interface Props {
  url: string;
  inline?: boolean;
}

const props = withDefaults(defineProps<Props>(), { inline: false });

// Inline (channel feed) playback asks the host to open the post instead of
// embedding the iframe in the feed — see `play()` for why (WEE-74).
const emit = defineEmits<{ expand: [] }>();

const videoInfo = computed(() => parseVideoUrl(props.url));
const playing = ref(false);
const error = ref(false);
const iframeLoaded = ref(false);
const spinnerTimedOut = ref(false);
const peertubeThumb = ref("");
const isFullscreen = ref(false);

// Belt-and-suspenders for old Android WebViews where iframe @load may never
// fire: stop showing our overlay spinner after this long so it can't become
// the very "eternal spinner" this fix removes. The "Open externally" fallback
// stays available regardless.
const SPINNER_TIMEOUT_MS = 10_000;
let spinnerTimer: ReturnType<typeof setTimeout> | null = null;

const clearSpinnerTimer = () => {
  if (spinnerTimer !== null) {
    clearTimeout(spinnerTimer);
    spinnerTimer = null;
  }
};

const thumbUrl = computed(() => peertubeThumb.value || videoInfo.value?.thumbUrl || "");

// Android WebView blocks autoplay for cross-origin sandboxed iframes, so the
// embed silently never starts and its own spinner spins forever (WEE-70). On
// native we drop ?autoplay=1 and let the user tap play inside the embed; on
// web/desktop autoplay works as before.
const embedSrc = computed(() => {
  const base = videoInfo.value?.embedUrl ?? "";
  return isNative ? base : `${base}?autoplay=1`;
});

// Our own overlay spinner is only shown while the iframe is still fetching.
// Once @load fires we hide it; if it never loads, the "Open externally"
// fallback is available from the first tap as a safety net.
const showSpinner = computed(
  () => playing.value && !iframeLoaded.value && !error.value && !spinnerTimedOut.value,
);

const onFullscreenChange = () => {
  isFullscreen.value = !!document.fullscreenElement;
};

onMounted(async () => {
  document.addEventListener("fullscreenchange", onFullscreenChange);

  const info = videoInfo.value;
  if (info?.type === "peertube" && info.apiUrl) {
    peertubeThumb.value = await fetchPeerTubeThumb(info.apiUrl);
  }
});

onUnmounted(() => {
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  clearSpinnerTimer();
});

// Android back: exit iframe fullscreen instead of closing the post.
// Priority 100 matches other full-screen overlays (MediaViewer, CallWindow).
useAndroidBackHandler("post-video-fullscreen", 100, () => {
  if (isFullscreen.value && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
    return true;
  }
  return false;
});

const play = () => {
  // WEE-74: a playing cross-origin sandboxed iframe captures Android WebView
  // touch gestures over its area, so inside the channel feed the feed stops
  // scrolling and tap-to-pause never reaches the embed (regression surfaced
  // once WEE-70 made the embed actually reach a playing state). Native inline
  // playback also needs a tap *inside* the iframe to start (no autoplay), which
  // is exactly what locks the gesture. Route feed playback to the post modal,
  // where the iframe lives in its own scroll context and can't lock the feed.
  // Web/desktop (mouse) keeps inline playback as before.
  if (props.inline && isNative) {
    emit("expand");
    return;
  }

  playing.value = true;
  spinnerTimedOut.value = false;
  clearSpinnerTimer();
  spinnerTimer = setTimeout(() => {
    spinnerTimedOut.value = true;
    spinnerTimer = null;
  }, SPINNER_TIMEOUT_MS);
};

const onIframeLoad = () => {
  iframeLoaded.value = true;
  clearSpinnerTimer();
};

const onIframeError = () => {
  error.value = true;
  playing.value = false;
  clearSpinnerTimer();
};

// Route through openExternalUrl: on native a plain <a target="_blank"> is a
// no-op inside Capacitor's WebView, so we launch a Custom Tab instead.
const openExternal = () => {
  void openExternalUrl(props.url);
};
</script>

<template>
  <div
    v-if="videoInfo"
    class="relative overflow-hidden rounded-lg bg-black"
    :class="'aspect-video w-full'"
  >
    <iframe
      v-if="playing && !error"
      :src="embedSrc"
      class="absolute inset-0 h-full w-full"
      frameborder="0"
      sandbox="allow-same-origin allow-scripts allow-presentation allow-forms allow-popups"
      allow="autoplay; picture-in-picture; fullscreen"
      allowfullscreen
      @load="onIframeLoad"
      @error="onIframeError"
    />

    <!-- Loading overlay while the iframe is fetching; hidden once @load fires -->
    <div
      v-if="showSpinner"
      data-testid="video-loading"
      class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60"
    >
      <svg class="animate-spin" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" opacity="0.85">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    </div>

    <!-- External fallback available from the first tap (not only on error) -->
    <a
      v-if="playing && !error"
      data-testid="video-external"
      :href="url"
      target="_blank"
      rel="noopener noreferrer"
      class="absolute bottom-2 right-2 z-10 rounded bg-black/60 px-2 py-1 text-xs text-white underline"
      @click.stop.prevent="openExternal"
    >Open externally</a>

    <template v-if="!playing && !error">
      <img
        v-if="thumbUrl"
        :src="thumbUrl"
        alt=""
        class="h-full w-full object-cover"
        loading="lazy"
      />
      <div v-else class="flex h-full w-full items-center justify-center bg-black">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1" opacity="0.3">
          <rect x="2" y="2" width="20" height="20" rx="2" />
          <path d="M10 8l6 4-6 4V8z" fill="white" opacity="0.3" />
        </svg>
      </div>

      <button
        class="absolute inset-0 flex items-center justify-center bg-black/30 transition-colors hover:bg-black/20"
        @click.stop="play"
      >
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 shadow-lg">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#000">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </button>
    </template>

    <div v-if="error" class="absolute inset-0 flex items-center justify-center bg-black">
      <a
        :href="url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm text-color-txt-ac underline"
        @click.stop.prevent="openExternal"
      >Open video externally</a>
    </div>
  </div>
</template>
