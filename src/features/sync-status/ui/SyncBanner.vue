<script setup lang="ts">
import { computed } from "vue";
import { useSyncStatus } from "../model/use-sync-status";

const { displayStatus, showBanner, bannerText, bannerVariant } = useSyncStatus();

const isSpinning = computed(() =>
  displayStatus.value === "connecting" || displayStatus.value === "catching_up",
);
const isSuccess = computed(() => displayStatus.value === "up_to_date");
const isError = computed(() => displayStatus.value === "error");
</script>

<template>
  <transition name="sync-banner">
    <div
      v-if="showBanner"
      class="flex items-center justify-center gap-1.5 px-4 py-1 text-xs leading-tight"
      :class="{
        'bg-red-500/10 text-red-400': bannerVariant === 'error',
        'bg-amber-500/10 text-amber-400': bannerVariant === 'warning',
        'bg-sky-500/10 text-sky-400': bannerVariant === 'info',
        'bg-emerald-500/10 text-emerald-400': bannerVariant === 'success',
      }"
    >
      <svg
        v-if="isSpinning"
        class="h-3 w-3 animate-spin"
        viewBox="0 0 16 16"
        fill="none"
      >
        <circle
          cx="8" cy="8" r="6"
          stroke="currentColor"
          stroke-width="2"
          stroke-dasharray="28"
          stroke-dashoffset="8"
        />
      </svg>

      <svg v-else-if="isSuccess" class="h-3 w-3" viewBox="0 0 16 16" fill="none">
        <path d="M3 8l4 4 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>

      <svg v-else-if="isError" class="h-3 w-3" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" />
        <path d="M8 5v4M8 11v0.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>

      <span>{{ bannerText }}</span>
    </div>
  </transition>
</template>

<style scoped>
.sync-banner-enter-active,
.sync-banner-leave-active {
  transition: max-height 200ms ease, opacity 200ms ease;
  overflow: hidden;
}
.sync-banner-enter-from,
.sync-banner-leave-to {
  max-height: 0;
  opacity: 0;
}
.sync-banner-enter-to,
.sync-banner-leave-from {
  max-height: 28px;
  opacity: 1;
}
</style>
