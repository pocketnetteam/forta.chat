<script setup lang="ts">
import { useLocaleStore } from "@/entities/locale";
import type { Locale } from "@/entities/locale";

const localeStore = useLocaleStore();
</script>

<template>
  <div class="safe-bottom flex h-full flex-col items-center overflow-y-auto bg-background-main px-4 py-8">
    <div class="my-auto flex w-full max-w-[360px] flex-col items-center gap-4">
      <div
        class="w-full rounded-2xl bg-background-total-theme px-6 pb-8 pt-10 shadow-sm"
      >
        <slot />
      </div>

      <!-- Language switcher -->
      <div class="flex items-center gap-1 text-[13px]">
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
