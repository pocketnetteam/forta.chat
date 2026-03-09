<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useI18n } from "@/shared/lib/i18n";

import CaptchaStep from "./steps/CaptchaStep.vue";
import ProfileStep from "./steps/ProfileStep.vue";
import SaveMnemonicStep from "./steps/SaveMnemonicStep.vue";

const { t } = useI18n();
const authStore = useAuthStore();

const currentStep = ref(1);
const totalSteps = 3;

const profileData = ref({ name: "", language: "en", about: "", image: undefined as string | undefined });

const handleProfileDone = (data: { name: string; language: string; about: string; image?: string }) => {
  profileData.value = { name: data.name, language: data.language, about: data.about, image: data.image };
  currentStep.value = 2;
};

onUnmounted(() => {
  authStore.clearRegistrationState();
});
</script>

<template>
  <div class="flex flex-col items-center">
    <!-- Icon -->
    <div
      class="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-color-bg-ac/10"
    >
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" class="text-color-txt-ac">
        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <circle cx="8.5" cy="7" r="4" stroke="currentColor" stroke-width="2" />
        <line x1="20" y1="8" x2="20" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <line x1="23" y1="11" x2="17" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </div>

    <!-- Heading -->
    <h1 class="mb-1 text-xl font-semibold text-text-color">
      {{ t("register.title") }}
    </h1>
    <p class="mb-5 text-center text-[13px] text-text-on-main-bg-color">
      {{ t("register.subtitle") }}
    </p>

    <!-- Progress bar -->
    <div class="mb-6 flex w-full gap-1.5">
      <div
        v-for="step in totalSteps"
        :key="step"
        class="h-1 flex-1 rounded-full transition-colors"
        :class="step <= currentStep ? 'bg-color-bg-ac' : 'bg-neutral-grad-0'"
      />
    </div>

    <!-- Steps -->
    <div class="w-full">
      <ProfileStep
        v-if="currentStep === 1"
        @done="handleProfileDone"
      />
      <CaptchaStep
        v-else-if="currentStep === 2"
        @done="currentStep = 3"
      />
      <SaveMnemonicStep
        v-else-if="currentStep === 3"
        :profile="profileData"
      />
    </div>

    <!-- Sign in link -->
    <p class="mt-6 text-center text-[13px] text-text-on-main-bg-color">
      {{ t("register.haveAccount") }}
      {{ " " }}
      <router-link
        :to="{ name: 'LoginPage' }"
        class="font-medium text-color-txt-ac hover:underline"
      >
        {{ t("register.signIn") }}
      </router-link>
    </p>
  </div>
</template>
