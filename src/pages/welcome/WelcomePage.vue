<script setup lang="ts">
import { useI18n } from "@/shared/lib/i18n";
import { useLocaleStore } from "@/entities/locale";
import type { Locale } from "@/entities/locale";

const router = useRouter();
const { t } = useI18n();
const localeStore = useLocaleStore();

const goToLogin = () => {
  router.push({ name: "LoginPage" });
};

const goToRegister = () => {
  router.push({ name: "RegisterPage" });
};
</script>

<template>
  <div
    class="flex h-full items-center justify-center bg-background-main px-4 py-8"
  >
    <div class="w-full max-w-[360px] flex flex-col items-center">
      <!-- Logo -->
      <img
        src="/forta-icon.png"
        alt="Forta Chat"
        class="mb-5 h-28 w-28 object-contain"
      />

      <!-- Title -->
      <h1 class="mb-2 text-center text-2xl font-semibold text-text-color">
        {{ t("welcome.title") }}
      </h1>

      <!-- Description -->
      <p class="mb-8 text-center text-sm leading-relaxed text-text-on-main-bg-color">
        {{ t("welcome.description") }}
      </p>

      <!-- Buttons -->
      <div class="flex w-full flex-col gap-3">
        <button
          class="h-11 w-full cursor-pointer rounded-xl bg-color-bg-ac text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1"
          @click="goToLogin"
        >
          {{ t("welcome.getStarted") }}
        </button>
        <button
          class="h-11 w-full cursor-pointer rounded-xl bg-transparent text-sm font-medium text-color-txt-ac transition-colors hover:bg-neutral-grad-0"
          @click="goToRegister"
        >
          {{ t("register.createAccount") }}
        </button>
      </div>

      <!-- Language switcher -->
      <div class="mt-4 flex items-center gap-1 text-[13px]">
        <button
          v-for="lang in (['en', 'ru'] as const)"
          :key="lang"
          class="cursor-pointer rounded-md px-2.5 py-1 transition-colors"
          :class="localeStore.locale === lang
            ? 'font-medium text-color-txt-ac'
            : 'text-text-on-main-bg-color hover:text-text-color'"
          @click="localeStore.setLocale(lang as Locale)"
        >
          {{ lang === 'en' ? 'English' : 'Русский' }}
        </button>
      </div>
    </div>
  </div>
</template>
