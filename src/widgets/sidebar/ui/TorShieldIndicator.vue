<script setup lang="ts">
import { useTorStore } from "@/entities/tor";
import { hasTor } from "@/shared/lib/platform";
import { useSidebarTab } from "@/widgets/sidebar/model/use-sidebar-tab";

const { t } = useI18n();
const torStore = useTorStore();
const { setTab, openSettingsContent } = useSidebarTab();

const shieldClass = computed(() => {
  const classes = [`tor-shield--${torStore.hintState}`];
  if (torStore.requestFlash) {
    classes.push(`tor-shield--flash-${torStore.requestFlash}`);
  }
  return classes;
});

const tooltipText = computed(() => {
  switch (torStore.hintState) {
    case "off":
      return t("tor.shieldDisabled");
    case "loading":
      return torStore.isConnecting ? t("tor.shieldStarting") : t("tor.shieldLoading");
    case "on":
      return t("tor.shieldRunning");
    case "failed":
      return t("tor.shieldDisabled");
    default:
      return t("tor.shieldDisabled");
  }
});

const openNetworking = () => {
  setTab("settings");
  openSettingsContent("networking");
};
</script>

<template>
  <button
    v-if="hasTor"
    type="button"
    class="tor-shield btn-press relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-neutral-grad-0"
    :class="shieldClass"
    :title="tooltipText"
    :aria-label="tooltipText"
    @click="openNetworking"
  >
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  </button>
</template>

<style scoped>
.tor-shield {
  color: rgb(var(--text-on-main-bg-color));
}

.tor-shield--off {
  opacity: 0.55;
}

.tor-shield--loading {
  color: rgb(var(--color-star-yellow));
  animation: tor-shield-pulse 1.5s ease-in-out infinite;
}

.tor-shield--on {
  color: rgb(var(--color-good));
}

.tor-shield--failed {
  color: rgb(var(--color-bad));
}

.tor-shield--flash-success {
  box-shadow: 0 0 0 2px rgba(var(--color-good), 0.45);
}

.tor-shield--flash-failed {
  box-shadow: 0 0 0 2px rgba(var(--color-bad), 0.45);
}

@keyframes tor-shield-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

@media (prefers-reduced-motion: reduce) {
  .tor-shield--loading {
    animation: none;
  }
}
</style>
