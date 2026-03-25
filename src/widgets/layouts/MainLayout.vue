<script setup lang="ts">
import AppHeader from "@/widgets/header/AppHeader.vue";
</script>

<template>
  <div class="safe-bottom flex h-full flex-col bg-background-total-theme">
    <AppHeader />
    <main class="flex-1 overflow-y-auto">
      <slot />
    </main>
  </div>
</template>
