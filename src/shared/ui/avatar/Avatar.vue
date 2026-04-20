<script setup lang="ts">
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

const hasImage = computed(() => !!props.src && !imgError.value);
</script>

<template>
  <div
    :class="sizeClass"
    class="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full"
    :style="{ backgroundColor: avatarColor }"
    role="img"
    :aria-label="props.name || 'User avatar'"
  >
    <!-- Initials are always rendered underneath the image so the tile never
         shows a blank frame while the image is loading (e.g. right after
         RecycleScroller recycles the row under a new src). Image covers
         initials once it paints. -->
    <span class="font-medium text-white">{{ initials }}</span>
    <img
      v-if="hasImage"
      :src="fixedSrc"
      :alt="props.name"
      class="absolute inset-0 h-full w-full object-cover"
      @error="imgError = true"
    />
  </div>
</template>
