<script setup lang="ts">
import { useI18n } from "@/shared/lib/i18n";
import { downloadLinks } from "@/shared/config/download-links";

const { t } = useI18n();

const STORAGE_KEY = "forta_skip_android_banner";

const isDismissed = ref(localStorage.getItem(STORAGE_KEY) === "1");

function dismiss() {
  isDismissed.value = true;
  localStorage.setItem(STORAGE_KEY, "1");
}
</script>

<template>
  <div
    v-if="!isDismissed"
    class="flex items-center gap-3 bg-color-bg-ac px-4 py-2.5"
  >
    <img
      src="/forta-icon.png"
      alt="Forta Chat"
      class="h-8 w-8 shrink-0 rounded-lg object-contain"
    />
    <p class="min-w-0 flex-1 truncate text-xs font-medium text-text-on-bg-ac-color">
      {{ t("banner.androidTitle") }}
    </p>
    <a
      :href="downloadLinks.androidApk"
      target="_blank"
      rel="noopener noreferrer"
      class="shrink-0 rounded-lg bg-white/20 px-3 py-1.5 text-xs font-semibold text-text-on-bg-ac-color transition-colors hover:bg-white/30"
    >
      {{ t("banner.androidCta") }}
    </a>
    <button
      class="shrink-0 cursor-pointer text-xs text-text-on-bg-ac-color/70 underline underline-offset-2 transition-colors hover:text-text-on-bg-ac-color"
      @click="dismiss"
    >
      {{ t("banner.androidDismiss") }}
    </button>
  </div>
</template>
