<script setup lang="ts">
import { parseVideoUrl, fetchPeerTubeThumb } from "@/shared/lib/video-embed";

interface Props {
  url: string;
  inline?: boolean;
}

const props = withDefaults(defineProps<Props>(), { inline: false });

const videoInfo = computed(() => parseVideoUrl(props.url));
const playing = ref(false);
const error = ref(false);
const peertubeThumb = ref("");

const thumbUrl = computed(() => peertubeThumb.value || videoInfo.value?.thumbUrl || "");

// Fetch PeerTube thumbnail via API
onMounted(async () => {
  const info = videoInfo.value;
  if (info?.type === "peertube" && info.apiUrl) {
    peertubeThumb.value = await fetchPeerTubeThumb(info.apiUrl);
  }
});

const play = () => {
  playing.value = true;
};

const onIframeError = () => {
  error.value = true;
  playing.value = false;
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
      :src="videoInfo.embedUrl + '?autoplay=1'"
      class="absolute inset-0 h-full w-full"
      frameborder="0"
      allow="autoplay; fullscreen; picture-in-picture"
      allowfullscreen
      @error="onIframeError"
    />

    <template v-else>
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
        @click.stop
      >Open video externally</a>
    </div>
  </div>
</template>
