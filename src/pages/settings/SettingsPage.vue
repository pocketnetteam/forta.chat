<script setup lang="ts">
import MainLayout from "@/widgets/layouts/MainLayout.vue";
import { useThemeStore } from "@/entities/theme";
import { useTorStore } from "@/entities/tor";
import { Toggle } from "@/shared/ui/toggle";
import { isNative } from "@/shared/lib/platform";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

const { t } = useI18n();
const themeStore = useThemeStore();
const torStore = useTorStore();
const router = useRouter();

useAndroidBackHandler("settings-page", 50, () => {
  router.push({ name: "ChatPage" });
  return true;
});

const isElectron = !!(window as any).electronAPI?.isElectron;
const showTor = isElectron || isNative;
const showDisableWarning = ref(false);

const torDotClass = computed(() => {
  switch (torStore.status) {
    case "started": return "bg-color-good";
    case "running":
    case "install": return "bg-color-star-yellow animate-pulse";
    case "failed": return "bg-color-bad";
    default: return "bg-neutral-400";
  }
});

const torSubtitle = computed(() => {
  if (!torStore.isEnabled) return null;
  const r = torStore.verifyResult;
  if (torStore.isVerifying) return { text: t("tor.verifying"), color: "text-text-on-main-bg-color", spin: true };
  if (torStore.isConnecting && torStore.info) return { text: torStore.info, color: "text-color-star-yellow", spin: false };
  if (torStore.isConnecting) return { text: t("tor.connecting"), color: "text-color-star-yellow", spin: false };
  if (torStore.status === "failed") return { text: t("settings.torFailed"), color: "text-color-bad", spin: false };
  if (torStore.isConnected && r?.isTor) return { text: r.ip, color: "text-color-good", spin: false };
  if (torStore.isConnected && r && !r.isTor) return { text: t("tor.notUsingTor"), color: "text-color-bad", spin: false };
  if (torStore.isConnected && !r) return { text: t("tor.verifying"), color: "text-text-on-main-bg-color", spin: true };
  return null;
});

const handleTorToggle = () => {
  if (torStore.isEnabled) {
    showDisableWarning.value = true;
  } else {
    torStore.toggle();
  }
};

const confirmDisableTor = () => {
  showDisableWarning.value = false;
  torStore.toggle();
};
</script>

<template>
  <MainLayout>
    <div class="mx-auto max-w-2xl px-4 py-6 md:px-6">
      <h1 class="mb-6 text-xl font-bold text-text-color">{{ t("settings.title") }}</h1>

      <div class="space-y-2">
        <!-- Appearance -->
        <button
          class="flex w-full items-center justify-between rounded-lg bg-background-secondary-theme p-4 transition-colors hover:bg-neutral-grad-0"
          @click="router.push({ name: 'AppearancePage' })"
        >
          <div class="flex items-center gap-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-color-bg-ac">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
            <span class="text-text-color">{{ t("settings.appearance") }}</span>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- Dark Mode toggle -->
        <div class="flex items-center justify-between rounded-lg bg-background-secondary-theme p-4">
          <div class="flex items-center gap-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            <span class="text-text-color">{{ t("settings.darkMode") }}</span>
          </div>
          <Toggle
            :model-value="themeStore.isDarkMode"
            @update:model-value="themeStore.toggleTheme()"
          />
        </div>

        <!-- Tor Proxy -->
        <div
          v-if="showTor"
          class="rounded-lg bg-background-secondary-theme p-4"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span class="text-text-color">{{ t("settings.torProxy") }}</span>
            </div>
            <Toggle
              :model-value="torStore.isEnabled"
              @update:model-value="handleTorToggle()"
            />
          </div>
          <div
            v-if="torSubtitle"
            class="mt-1.5 flex items-center gap-2 pl-8"
          >
            <span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" :class="torDotClass" />
            <span class="text-xs" :class="torSubtitle.color">{{ torSubtitle.text }}</span>
            <button
              v-if="torStore.isConnected && !torStore.isVerifying"
              class="ml-auto shrink-0 p-0.5 text-text-on-main-bg-color transition-colors hover:text-text-color"
              @click="torStore.verify()"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <svg
              v-if="torSubtitle.spin"
              class="ml-auto h-3.5 w-3.5 shrink-0 contain-strict animate-spin text-text-on-main-bg-color"
              viewBox="0 0 24 24" fill="none"
            >
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
            </svg>
          </div>
        </div>

        <!-- Tor disable warning dialog -->
        <Teleport to="body">
          <div
            v-if="showDisableWarning"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            @click.self="showDisableWarning = false"
          >
            <div class="mx-4 max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
              <p class="mb-4 text-sm text-text-color">
                {{ t("tor.disableWarning") }}
              </p>
              <div class="flex justify-end gap-3">
                <button
                  class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
                  @click="showDisableWarning = false"
                >
                  {{ t("common.cancel") }}
                </button>
                <button
                  class="rounded-lg bg-color-bad px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80"
                  @click="confirmDisableTor()"
                >
                  {{ t("tor.disable") }}
                </button>
              </div>
            </div>
          </div>
        </Teleport>

        <!-- Notifications (placeholder) -->
        <div class="flex items-center justify-between rounded-lg bg-background-secondary-theme p-4">
          <div class="flex items-center gap-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <span class="text-text-color">{{ t("settings.notifications") }}</span>
          </div>
          <span class="text-xs text-text-on-main-bg-color">{{ t("settings.enabled") }}</span>
        </div>

        <!-- Privacy (placeholder) -->
        <div class="flex items-center justify-between rounded-lg bg-background-secondary-theme p-4">
          <div class="flex items-center gap-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span class="text-text-color">{{ t("settings.privacy") }}</span>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>
    </div>
  </MainLayout>
</template>
