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
  <div class="sync-banner-grid" :class="{ 'sync-banner-grid--open': showBanner }">
    <div class="sync-banner-grid-inner">
      <div
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
          class="contain-strict h-3 w-3 animate-spin"
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
    </div>
  </div>
</template>

<style scoped>
.sync-banner-grid {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 200ms ease, opacity 200ms ease;
  opacity: 0;
}
.sync-banner-grid--open {
  grid-template-rows: 1fr;
  opacity: 1;
}
.sync-banner-grid-inner {
  min-height: 0;
  overflow: hidden;
}
</style>
