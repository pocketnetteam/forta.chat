<script setup lang="ts">
import { ref, onMounted } from "vue";
import { isWeb } from "@/shared/lib/platform";
import { useI18n } from "@/shared/lib/i18n";

const DISMISS_KEY = "app-download-banner-dismissed";
const DOWNLOAD_URL = "https://forta.chat/#/download";

const { t } = useI18n();
const visible = ref(false);

const isAndroidBrowser = isWeb && /Android/i.test(navigator.userAgent);

onMounted(() => {
  if (isAndroidBrowser && !localStorage.getItem(DISMISS_KEY)) {
    visible.value = true;
  }
});

const dismiss = () => {
  visible.value = false;
  localStorage.setItem(DISMISS_KEY, "1");
};

const openDownload = () => {
  window.open(DOWNLOAD_URL, "_blank", "noopener");
};
</script>

<template>
  <transition name="app-banner">
    <div
      v-if="visible"
      class="flex items-center gap-3 bg-sky-600 px-3 py-2 text-white shadow-md"
    >
      <!-- App icon -->
      <img
        src="/forta-icon.png"
        alt="Forta Chat"
        class="h-10 w-10 shrink-0 rounded-lg"
      />

      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold leading-tight">Forta Chat</div>
        <div class="text-xs leading-tight opacity-80">
          {{ t("appBanner.subtitle") }}
        </div>
      </div>

      <button
        class="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-semibold text-sky-600 active:bg-sky-50"
        @click="openDownload"
      >
        {{ t("appBanner.download") }}
      </button>

      <button
        class="shrink-0 p-1 opacity-70 active:opacity-100"
        :aria-label="t('appBanner.close')"
        @click="dismiss"
      >
        <svg class="h-4 w-4" viewBox="0 0 16 16" fill="none">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
  </transition>
</template>

<style scoped>
.app-banner-enter-active,
.app-banner-leave-active {
  transition: max-height 250ms ease, opacity 250ms ease;
  overflow: hidden;
}
.app-banner-enter-from,
.app-banner-leave-to {
  max-height: 0;
  opacity: 0;
}
.app-banner-enter-to,
.app-banner-leave-from {
  max-height: 64px;
  opacity: 1;
}
</style>
