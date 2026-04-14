<script setup lang="ts">
interface Props {
  size?: "sm" | "md" | "lg";
}

const props = withDefaults(defineProps<Props>(), { size: "md" });

const sizeClass = computed(() => ({
  sm: "h-4 w-4 border-2",
  md: "h-8 w-8 border-3",
  lg: "h-12 w-12 border-4"
}[props.size]));
</script>

<template>
  <div
    role="status"
    aria-label="Loading"
    :class="sizeClass"
    class="shrink-0 contain-strict animate-spin rounded-full border-color-bg-ac/20 border-t-color-bg-ac"
  />
</template>
