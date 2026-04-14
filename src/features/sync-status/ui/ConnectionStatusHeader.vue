<script setup lang="ts">
import { useSyncStatus } from "../model/use-sync-status";

const { t } = useI18n();
const { displayStatus, bannerText, bannerVariant } = useSyncStatus();

const isActive = computed(() => {
  const s = displayStatus.value;
  return s === "connecting" || s === "catching_up" || s === "offline" || s === "error";
});

const showSpinner = computed(() => {
  const s = displayStatus.value;
  return s === "connecting" || s === "catching_up" || s === "error";
});

const colorClass = computed(() => {
  switch (bannerVariant.value) {
    case "error": return "text-red-400";
    case "warning": return "text-amber-400";
    case "info": return "text-sky-400";
    case "success": return "text-emerald-400";
    default: return "text-sky-400";
  }
});

const tooltipOpen = ref(false);
let hideTimeout: ReturnType<typeof setTimeout> | null = null;

const showTooltip = () => {
  if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
  tooltipOpen.value = true;
};
const scheduleHide = () => {
  hideTimeout = setTimeout(() => { tooltipOpen.value = false; }, 200);
};
const toggleTooltip = () => {
  tooltipOpen.value = !tooltipOpen.value;
};
</script>

<template>
  <span class="flex-1 pl-1 text-base font-semibold text-text-color inline-flex items-center gap-2">
    {{ t("nav.chats") }}

    <!-- Inline status indicator -->
    <transition name="indicator-fade">
      <span
        v-if="isActive"
        class="relative inline-flex items-center"
        @mouseenter="showTooltip"
        @mouseleave="scheduleHide"
        @click.stop="toggleTooltip"
      >
        <!-- Spinning loader -->
        <svg
          v-if="showSpinner"
          class="h-3.5 w-3.5 shrink-0 contain-strict animate-spin cursor-pointer"
          :class="colorClass"
          viewBox="0 0 16 16"
          fill="none"
        >
          <circle
            cx="8" cy="8" r="6"
            stroke="currentColor"
            stroke-width="2"
            stroke-dasharray="28"
            stroke-dashoffset="8"
            stroke-linecap="round"
          />
        </svg>
        <!-- Offline dot (no spinner) -->
        <span
          v-else
          class="inline-block h-2 w-2 cursor-pointer rounded-full"
          :class="colorClass"
        />

        <!-- Tooltip popup -->
        <transition name="tooltip-fade">
          <span
            v-if="tooltipOpen"
            class="absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-normal shadow-lg"
            :class="{
              'bg-red-500/15 text-red-400': bannerVariant === 'error',
              'bg-amber-500/15 text-amber-400': bannerVariant === 'warning',
              'bg-sky-500/15 text-sky-400': bannerVariant === 'info',
              'bg-emerald-500/15 text-emerald-400': bannerVariant === 'success',
            }"
            @mouseenter="showTooltip"
            @mouseleave="scheduleHide"
          >
            {{ bannerText }}
          </span>
        </transition>
      </span>
    </transition>
  </span>
</template>

<style scoped>
.indicator-fade-enter-active,
.indicator-fade-leave-active {
  transition: opacity 300ms ease;
}
.indicator-fade-enter-from,
.indicator-fade-leave-to {
  opacity: 0;
}

.tooltip-fade-enter-active,
.tooltip-fade-leave-active {
  transition: opacity 150ms ease, transform 150ms ease;
}
.tooltip-fade-enter-from,
.tooltip-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-4px);
}
.tooltip-fade-enter-to,
.tooltip-fade-leave-from {
  transform: translateX(-50%) translateY(0);
}
</style>
