<script setup lang="ts">
defineProps<{ count: number }>();
</script>

<template>
  <div class="mx-auto flex max-w-6xl items-center gap-3 py-2">
    <div class="h-px flex-1 bg-color-bg-ac/60" />
    <span class="whitespace-nowrap text-xs font-medium text-color-bg-ac">
      {{ count }} {{ count === 1 ? 'unread message' : 'unread messages' }}
    </span>
    <div class="h-px flex-1 bg-color-bg-ac/60" />
  </div>
</template>
