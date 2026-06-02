<script setup lang="ts">
import { useBastyonInterop } from "../model/use-bastyon-interop";

const { showWarning, dismiss } = useBastyonInterop();
const { t } = useI18n();
</script>

<template>
  <div
    v-if="showWarning"
    class="mx-2 mb-2 flex gap-3 rounded-lg border border-color-star-yellow/40 bg-color-star-yellow/10 px-3 py-3"
    role="alert"
  >
    <svg
      class="mt-0.5 shrink-0 text-color-star-yellow"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-semibold text-text-color">
        {{ t("interop.bastyonWarning.title") }}
      </p>
      <p class="mt-0.5 text-xs leading-snug text-text-on-main-bg-color">
        {{ t("interop.bastyonWarning.body") }}
      </p>
      <button
        class="mt-2 text-xs font-medium text-color-bg-ac transition-opacity hover:opacity-80"
        @click="dismiss"
      >
        {{ t("interop.bastyonWarning.dismiss") }}
      </button>
    </div>
  </div>
</template>
