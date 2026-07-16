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
    <svg width="52%" height="52%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  </span>
</template>
