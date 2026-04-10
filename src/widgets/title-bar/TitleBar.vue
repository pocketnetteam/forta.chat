<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useTorStore } from "@/entities/tor";
import { useSidebarTab } from "@/widgets/sidebar/model/use-sidebar-tab";

const authStore = useAuthStore();
const torStore = useTorStore();
const { setTab } = useSidebarTab();
const { t } = useI18n();
const router = useRouter();

const torStatusText = computed(() => {
  switch (torStore.status) {
    case "started": return t("tor.connected");
    case "running":
    case "install": return t("tor.connecting");
    case "failed": return t("tor.error");
    default: return t("tor.off");
  }
});

const isMac = (window as any).electronAPI?.platform === "darwin";
const isMaximized = ref(false);

onMounted(() => {
  const api = (window as any).electronAPI;
  if (!api) return;
  api.onMaximized?.(() => { isMaximized.value = true; });
  api.onUnmaximized?.(() => { isMaximized.value = false; });
});

const minimize = () => (window as any).electronAPI?.minimize();
const maximize = () => (window as any).electronAPI?.maximize();
const close = () => (window as any).electronAPI?.close();

const torDotColor = computed(() => {
  switch (torStore.status) {
    case "started": return "#22c55e";
    case "running":
    case "install": return "#eab308";
    case "failed": return "#ef4444";
    default: return null;
  }
});
</script>

<template>
  <!-- Custom title bar — only rendered in Electron -->
  <div class="title-bar">
    <!-- macOS: empty space for traffic lights -->
    <div v-if="isMac" class="w-[76px] shrink-0" />

    <!-- App name + username -->
    <div class="flex min-w-0 flex-1 items-center gap-2 px-3">
      <span class="text-xs font-semibold text-text-color">{{ t("titleBar.appName") }}</span>
      <span
        v-if="authStore.userInfo?.name"
        class="truncate text-xs text-text-on-main-bg-color"
      >
        — {{ authStore.userInfo.name }}
      </span>
      <!-- Tor status badge -->
      <button
        v-if="torDotColor"
        class="tor-badge"
        :title="torStore.info || torStatusText"
        @click="router.push({ name: 'ChatPage' }); setTab('settings')"
      >
        <span
          class="tor-dot"
          :class="{ 'tor-dot--pulse': torStore.isConnecting }"
          :style="{ backgroundColor: torDotColor }"
        />
        <span class="tor-label" :style="{ color: torDotColor }">
          {{ torStore.isConnecting && torStore.info ? torStore.info.replace('Bootstrapped ', '') : torStatusText }}
        </span>
      </button>
    </div>

    <!-- Window controls (Windows/Linux only — macOS uses native traffic lights) -->
    <div v-if="!isMac" class="flex shrink-0">
      <button class="win-btn hover:bg-neutral-grad-0" @click="minimize" :title="t('titleBar.minimize')">
        <svg width="10" height="1" viewBox="0 0 10 1">
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button class="win-btn hover:bg-neutral-grad-0" @click="maximize" :title="t('titleBar.maximize')">
        <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10">
          <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" stroke-width="1" />
        </svg>
        <svg v-else width="10" height="10" viewBox="0 0 10 10">
          <rect x="2.5" y="0.5" width="7" height="7" stroke="currentColor" fill="none" stroke-width="1" />
          <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" fill="rgb(var(--background-total-theme))" stroke-width="1" />
        </svg>
      </button>
      <button class="win-btn hover:!bg-red-500 hover:!text-white" @click="close" :title="t('titleBar.close')">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2" />
          <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.title-bar {
  display: flex;
  align-items: center;
  height: 32px;
  flex-shrink: 0;
  background: rgb(var(--background-total-theme));
  border-bottom: 1px solid rgb(var(--neutral-grad-0));
  -webkit-app-region: drag;
  user-select: none;
}

.tor-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px 1px 4px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.06);
  -webkit-app-region: no-drag;
  cursor: pointer;
  position: relative;
}
.tor-badge::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgba(255, 255, 255, 0.06);
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
.tor-badge:hover::before {
  opacity: 1;
}

.tor-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tor-dot--pulse {
  animation: tor-pulse 1.5s ease-in-out infinite;
}

.tor-label {
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  line-height: 1;
}

@keyframes tor-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.win-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 32px;
  color: rgb(var(--text-on-main-bg-color));
  -webkit-app-region: no-drag;
  position: relative;
}
.win-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.1);
  opacity: 0;
  transition: opacity 0.1s;
  pointer-events: none;
}
.win-btn:hover::before {
  opacity: 1;
}
</style>
