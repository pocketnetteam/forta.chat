<script setup lang="ts">
import MainLayout from "@/widgets/layouts/MainLayout.vue";
import { useThemeStore } from "@/entities/theme";
import { useTorStore } from "@/entities/tor";
import { Toggle } from "@/shared/ui/toggle";

const themeStore = useThemeStore();
const torStore = useTorStore();
const router = useRouter();

const isElectron = !!(window as any).electronAPI?.isElectron;

const torStatusColor = computed(() => {
  switch (torStore.status) {
    case "started": return "text-color-good";
    case "running":
    case "install": return "text-color-star-yellow";
    case "failed": return "text-color-bad";
    default: return "text-text-on-main-bg-color";
  }
});

const torDotClass = computed(() => {
  switch (torStore.status) {
    case "started": return "bg-color-good";
    case "running":
    case "install": return "bg-color-star-yellow animate-pulse";
    case "failed": return "bg-color-bad";
    default: return "bg-neutral-400";
  }
});
</script>

<template>
  <MainLayout>
    <div class="mx-auto max-w-2xl p-6">
      <h1 class="mb-6 text-xl font-bold text-text-color">Settings</h1>

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
            <span class="text-text-color">Appearance</span>
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
            <span class="text-text-color">Dark Mode</span>
          </div>
          <Toggle
            :model-value="themeStore.isDarkMode"
            @update:model-value="themeStore.toggleTheme()"
          />
        </div>

        <!-- Tor Proxy (Electron only) -->
        <div
          v-if="isElectron"
          class="rounded-lg bg-background-secondary-theme p-4"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span class="text-text-color">Tor Proxy</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="flex items-center gap-1.5">
                <span class="inline-block h-2 w-2 rounded-full" :class="torDotClass" />
                <span class="text-xs font-medium" :class="torStatusColor">{{ torStore.statusLabel }}</span>
              </div>
              <Toggle
                :model-value="torStore.isEnabled"
                @update:model-value="torStore.toggle()"
              />
            </div>
          </div>
          <!-- Bootstrap progress line -->
          <p
            v-if="torStore.isConnecting && torStore.info"
            class="mt-2 pl-8 text-xs text-color-star-yellow"
          >
            {{ torStore.info }}
          </p>
          <p
            v-else-if="torStore.status === 'failed'"
            class="mt-2 pl-8 text-xs text-color-bad"
          >
            Tor failed to start. Try toggling off and on again.
          </p>
        </div>

        <!-- Notifications (placeholder) -->
        <div class="flex items-center justify-between rounded-lg bg-background-secondary-theme p-4">
          <div class="flex items-center gap-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <span class="text-text-color">Notifications</span>
          </div>
          <span class="text-xs text-text-on-main-bg-color">Enabled</span>
        </div>

        <!-- Privacy (placeholder) -->
        <div class="flex items-center justify-between rounded-lg bg-background-secondary-theme p-4">
          <div class="flex items-center gap-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span class="text-text-color">Privacy</span>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>
    </div>
  </MainLayout>
</template>
