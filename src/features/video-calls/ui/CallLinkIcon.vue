<script setup lang="ts">
interface Props {
  /** Tailwind size classes, default h-10 w-10 */
  sizeClass?: string;
  /** Render on an accent/own-bubble background (white-on-translucent) so the
   *  icon stays visible against the blue "own message" bubble. */
  onAccent?: boolean;
}
withDefaults(defineProps<Props>(), { sizeClass: "h-10 w-10", onAccent: false });
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-xl"
    :class="[sizeClass, onAccent ? 'bg-white/20 text-white' : 'bg-color-bg-ac/15 text-color-bg-ac']"
    aria-hidden="true"
  >
    <svg width="55%" height="55%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  </span>
</template>
