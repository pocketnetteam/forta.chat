<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "@/shared/lib/i18n";
import type { RegistrationPhase } from "@/entities/auth/model/stores";

const props = defineProps<{
  phase: RegistrationPhase;
  errorMessage?: string;
  errorType?: 'username' | 'timeout' | 'network' | null;
}>();

const emit = defineEmits<{
  "back-to-name": [newName: string];
  "retry": [];
}>();

const { t } = useI18n();

const retryName = ref("");

// Map phase → UI step (1-indexed)
const currentStep = computed(() => {
  switch (props.phase) {
    case "init": return 1;
    case "broadcasting":
    case "confirming": return 2;
    case "done": return 3;
    case "error": return -1;
  }
});

const isError = computed(() => props.phase === "error");

// Step content
const stepTitle = computed(() => {
  if (isError.value) {
    if (props.errorType === 'timeout') return t("register.timeoutErrorTitle");
    if (props.errorType === 'network') return t("register.networkErrorTitle");
    return t("register.errorTitle");
  }
  switch (currentStep.value) {
    case 1: return t("register.step1Title");
    case 2: return t("register.step2Title");
    case 3: return t("register.step3Title");
    default: return "";
  }
});

const stepText = computed(() => {
  if (isError.value) {
    if (props.errorType === 'timeout') return t("register.timeoutErrorHint");
    if (props.errorType === 'network') return t("register.networkErrorHint");
    return props.errorMessage || t("register.usernameRejectedHint");
  }
  switch (currentStep.value) {
    case 1: return t("register.step1Text");
    case 2: return t("register.step2Text");
    case 3: return t("register.step3Text");
    default: return "";
  }
});

// Track phase changes for transition animation
const transitionKey = ref(0);
watch(() => props.phase, () => { transitionKey.value++; });

const handleRetry = () => {
  const trimmed = retryName.value.trim();
  if (!trimmed) return;
  emit("back-to-name", trimmed);
};
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-white dark:bg-gray-900">
    <div class="flex w-full max-w-sm flex-col items-center px-8">

      <!-- Step Indicator (3 dots + connecting lines) -->
      <div class="mb-8 flex w-full max-w-[240px] items-center justify-center">
        <template v-for="step in 3" :key="step">
          <!-- Dot -->
          <div
            class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all duration-500"
            :class="[
              isError
                ? 'bg-red-500/15 ring-1 ring-red-400/40'
                : step < currentStep
                  ? 'bg-color-bg-ac'
                  : step === currentStep
                    ? 'stepper-dot-active bg-color-bg-ac'
                    : 'bg-neutral-grad-0 ring-1 ring-neutral-grad-1'
            ]"
          >
            <svg v-if="!isError && step < currentStep" class="h-3.5 w-3.5 text-white" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 8.5 7 11.5 12 5" />
            </svg>
            <span v-else class="text-[11px] font-semibold" :class="[
              isError ? 'text-red-400' : step <= currentStep ? 'text-white' : 'text-neutral-grad-2'
            ]">{{ step }}</span>
          </div>
          <!-- Connecting line -->
          <div v-if="step < 3" class="relative mx-1.5 h-[2px] flex-1">
            <div class="absolute inset-0 rounded-full bg-neutral-grad-0" />
            <div
              class="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
              :class="isError ? 'bg-red-400' : 'bg-color-bg-ac'"
              :style="{ width: step < currentStep ? '100%' : step === currentStep && (phase === 'confirming' || phase === 'broadcasting') ? '50%' : '0%' }"
            />
          </div>
        </template>
      </div>

      <!-- Step Content (animated transition) -->
      <Transition name="stepper-fade" mode="out-in">
        <div :key="transitionKey" class="flex flex-col items-center text-center">

          <!-- Icon area -->
          <div class="mb-5 flex h-14 w-14 items-center justify-center">
            <!-- Step 1: Pulsing ring loader -->
            <div v-if="currentStep === 1" class="stepper-ring-loader">
              <svg class="h-14 w-14 text-color-bg-ac" viewBox="0 0 56 56" fill="none">
                <circle cx="28" cy="28" r="24" stroke="currentColor" stroke-width="2" opacity="0.1" />
                <circle cx="28" cy="28" r="24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="stepper-arc" />
                <path d="M22 28l-2-6h16l-2 6M22 28h12M24 28v6h8v-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5" />
              </svg>
            </div>

            <!-- Step 2: Orbiting dots -->
            <div v-else-if="currentStep === 2" class="stepper-orbit">
              <svg class="h-14 w-14 text-color-bg-ac" viewBox="0 0 56 56" fill="none">
                <circle cx="28" cy="28" r="24" stroke="currentColor" stroke-width="1.5" opacity="0.08" stroke-dasharray="4 4" />
                <circle cx="28" cy="28" r="6" stroke="currentColor" stroke-width="1.5" opacity="0.3" />
                <circle cx="28" cy="28" r="2" fill="currentColor" opacity="0.5" />
              </svg>
              <div class="stepper-orbit-dot" style="--orbit-delay: 0s" />
              <div class="stepper-orbit-dot" style="--orbit-delay: -1.2s" />
              <div class="stepper-orbit-dot" style="--orbit-delay: -2.4s" />
            </div>

            <!-- Step 3: Success -->
            <svg v-else-if="currentStep === 3" class="h-14 w-14 text-green-500" viewBox="0 0 56 56" fill="none">
              <circle cx="28" cy="28" r="24" stroke="currentColor" stroke-width="2" opacity="0.15" />
              <circle cx="28" cy="28" r="24" stroke="currentColor" stroke-width="2" class="stepper-circle-draw" />
              <polyline points="18,29 25,36 38,22" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="stepper-check-draw" />
            </svg>

            <!-- Error -->
            <div v-else-if="isError" class="flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10">
              <svg class="h-6 w-6 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
          </div>

          <!-- Title -->
          <h2 class="mb-1.5 text-base font-semibold text-gray-900 dark:text-white">
            {{ stepTitle }}
          </h2>

          <!-- Subtitle -->
          <p class="max-w-[260px] text-[13px] leading-5 text-gray-400 dark:text-gray-500">
            {{ stepText }}
          </p>

          <!-- Error: username retry form -->
          <template v-if="isError && errorType === 'username'">
            <input
              v-model="retryName"
              type="text"
              :placeholder="t('register.namePlaceholder')"
              maxlength="20"
              class="mt-4 h-11 w-full rounded-xl border border-neutral-grad-1 bg-background-total-theme px-3.5 text-sm text-text-color outline-none transition-colors placeholder:text-neutral-grad-2 focus:border-color-bg-ac"
              @keyup.enter="handleRetry"
            />
            <p v-if="errorMessage" class="mt-1 text-xs text-color-bad">{{ errorMessage }}</p>
            <button
              :disabled="!retryName.trim()"
              class="mt-3 flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-color-bg-ac text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1 disabled:cursor-default disabled:opacity-50"
              @click="handleRetry"
            >
              {{ t("register.backToName") }}
            </button>
          </template>

          <!-- Error: timeout / network — generic retry -->
          <template v-else-if="isError">
            <button
              class="mt-4 flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-color-bg-ac text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1"
              @click="emit('retry')"
            >
              {{ t("register.retry") }}
            </button>
          </template>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
/* Step transition */
.stepper-fade-enter-active { transition: opacity 0.35s ease, transform 0.35s ease; }
.stepper-fade-leave-active { transition: opacity 0.15s ease; }
.stepper-fade-enter-from { opacity: 0; transform: translateY(8px); }
.stepper-fade-leave-to { opacity: 0; }

/* Active dot pulse */
.stepper-dot-active { animation: stepper-pulse 2.5s ease-in-out infinite; }
@keyframes stepper-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--color-bg-ac-rgb, 59 130 246), 0.3); }
  50% { box-shadow: 0 0 0 5px rgba(var(--color-bg-ac-rgb, 59 130 246), 0); }
}

/* Step 1: Spinning arc loader */
.stepper-arc {
  stroke-dasharray: 80 151;
  animation: stepper-spin 1.4s linear infinite;
  transform-origin: center;
}
@keyframes stepper-spin {
  to { transform: rotate(360deg); }
}

/* Step 2: Orbiting dots */
.stepper-orbit { position: relative; width: 3.5rem; height: 3.5rem; }
.stepper-orbit-dot {
  position: absolute;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  top: 50%;
  left: 50%;
  margin: -3px 0 0 -3px;
  color: var(--color-bg-ac, #3b82f6);
  animation: stepper-orbit-move 3.6s linear infinite var(--orbit-delay);
}
@keyframes stepper-orbit-move {
  0% { transform: rotate(0deg) translateX(24px) scale(0.6); opacity: 0.3; }
  50% { transform: rotate(180deg) translateX(24px) scale(1); opacity: 1; }
  100% { transform: rotate(360deg) translateX(24px) scale(0.6); opacity: 0.3; }
}

/* Step 3: Success checkmark draw */
.stepper-circle-draw {
  stroke-dasharray: 151;
  stroke-dashoffset: 151;
  animation: stepper-draw 0.6s ease 0.1s forwards;
}
.stepper-check-draw {
  stroke-dasharray: 36;
  stroke-dashoffset: 36;
  animation: stepper-draw 0.3s ease 0.5s forwards;
}
@keyframes stepper-draw {
  to { stroke-dashoffset: 0; }
}
</style>
