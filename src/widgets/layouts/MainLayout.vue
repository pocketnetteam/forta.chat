<script setup lang="ts">
import AppHeader from "@/widgets/header/AppHeader.vue";
import { AndroidDownloadBanner } from "@/features/android-download-banner";
import { isAndroidWeb } from "@/shared/lib/platform";
</script>

<template>
  <div class="safe-bottom flex h-full flex-col bg-background-total-theme">
    <AndroidDownloadBanner v-if="isAndroidWeb" />
    <AppHeader />
    <main class="flex-1 overflow-y-auto">
      <slot />
    </main>
  </div>
</template>
