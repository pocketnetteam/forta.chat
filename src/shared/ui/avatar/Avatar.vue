<script setup lang="ts">
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

/** Fix bastyon.com:8092 → pocketnet.app:8092 (SSL cert mismatch) */
const fixedSrc = computed(() => {
  if (!props.src) return "";
  return props.src.replace("bastyon.com:8092", "pocketnet.app:8092");
});

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
      v-if="!showFallback"
      :src="fixedSrc"
      :alt="props.name"
      class="h-full w-full object-cover"
      @error="imgError = true"
    />
    <span v-else class="font-medium text-white">{{ initials }}</span>
  </div>
</template>
