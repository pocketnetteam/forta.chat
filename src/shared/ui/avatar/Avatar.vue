<script setup lang="ts">
import { getCachedAvatarUrl, isAvatarCached, invalidateCachedAvatar, prefetchAvatar } from "@/shared/lib/avatar-cache";
import { normalizePocketnetImageUrl } from "@/shared/lib/image-url";

interface Props {
  src?: string;
  name?: string;
  size?: "sm" | "md" | "lg" | "xl";
}

const props = withDefaults(defineProps<Props>(), {
  src: "",
  name: "",
  size: "md"
});

// Telegram-style avatar colors (7 accent colors)
const AVATAR_COLORS = [
  "#E17076", // red
  "#FAA774", // orange
  "#A695E7", // purple
  "#7BC862", // green
  "#6EC9CB", // teal
  "#65AADD", // blue
  "#EE7AAE", // pink
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

const avatarColor = computed(() => {
  const key = props.name || "?";
  return AVATAR_COLORS[hashString(key) % AVATAR_COLORS.length];
});

const initials = computed(() => {
  if (!props.name) return "?";
  return props.name
    .split(" ")
    .map(w => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
});

const sizeClass = computed(() => ({
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-14 w-14 text-base",
  xl: "h-20 w-20 text-lg"
}[props.size]));

const imgError = ref(false);

const fixedSrc = computed(() => normalizePocketnetImageUrl(props.src));

const resolvedSrc = ref("");

watch(fixedSrc, (url) => {
  imgError.value = false;
  if (!url) { resolvedSrc.value = ""; return; }

  resolvedSrc.value = getCachedAvatarUrl(url);

  if (!isAvatarCached(url)) {
    prefetchAvatar(url).then((blobUrl) => {
      if (fixedSrc.value === url) {
        resolvedSrc.value = blobUrl;
        if (blobUrl.startsWith("blob:")) imgError.value = false;
      }
    });
  }
}, { immediate: true });

function onImgError() {
  if (resolvedSrc.value.startsWith("blob:")) {
    const url = fixedSrc.value;
    if (!url) return;
    invalidateCachedAvatar(url);
    resolvedSrc.value = url;
    prefetchAvatar(url).then((blobUrl) => {
      if (fixedSrc.value === url) {
        resolvedSrc.value = blobUrl;
        if (blobUrl.startsWith("blob:")) imgError.value = false;
      }
    });
    return;
  }
  imgError.value = true;
}

const showFallback = computed(() => !props.src || imgError.value);
</script>

<template>
  <div
    :class="sizeClass"
    class="flex shrink-0 items-center justify-center overflow-hidden rounded-full"
    :style="showFallback ? { backgroundColor: avatarColor } : {}"
    role="img"
    :aria-label="props.name || 'User avatar'"
  >
    <img
      v-if="resolvedSrc"
      v-show="!showFallback"
      :src="resolvedSrc"
      :alt="props.name"
      class="h-full w-full object-cover"
      @error="onImgError"
      @load="imgError = false"
    />
    <span v-if="showFallback" class="font-medium text-white">{{ initials }}</span>
  </div>
</template>
