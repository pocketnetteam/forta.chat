<script setup lang="ts">
import { useI18n } from "@/shared/lib/i18n";
import { useLocaleStore } from "@/entities/locale";
import type { Locale } from "@/entities/locale";
import { downloadLinks } from "@/shared/config/download-links";
import {
  useLatestReleaseDownloads,
  type DownloadPlatform,
} from "@/shared/lib/download";
import { AppPages } from "@/app/providers/router";
import { useAuthStore } from "@/entities/auth";

const { t } = useI18n();
const localeStore = useLocaleStore();
const authStore = useAuthStore();
const router = useRouter();

const {
  loading,
  version,
  recommendedPlatform,
  sortedPlatforms,
  urlFor,
  playStoreUrl,
  releasesPageUrl,
} = useLatestReleaseDownloads();

function platformLabel(platform: DownloadPlatform): string {
  switch (platform) {
    case "windows":
      return t("apps.platform.windows");
    case "macos":
      return t("apps.platform.macos");
    case "linux":
      return t("apps.platform.linux");
    case "android":
      return t("apps.platform.android");
    default: {
      const _exhaustive: never = platform;
      return _exhaustive;
    }
  }
}

function goBack() {
  if (window.history.state?.back != null) {
    router.back();
    return;
  }
  void router.push({
    name: authStore.isAuthenticated ? AppPages.chat : AppPages.welcome,
  });
}

function goToLanding() {
  void router.push({ name: AppPages.download });
}
</script>

<template>
  <div class="apps-page h-full overflow-y-auto bg-[#09090b] text-white">
    <header class="flex items-center justify-between gap-3 px-5 py-4 sm:px-8">
      <div class="flex min-w-0 items-center gap-2">
        <button
          type="button"
          class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          :aria-label="t('nav.back')"
          @click="goBack"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <img src="/forta-icon.png" alt="Forta Chat" class="h-8 w-8 object-contain" />
        <span class="truncate text-base font-semibold tracking-tight">Forta Chat</span>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <button
          type="button"
          class="cursor-pointer text-[13px] text-white/45 transition-colors hover:text-white/80"
          @click="goToLanding"
        >
          {{ t("apps.aboutProduct") }}
        </button>
        <div class="flex items-center gap-1 text-[13px]">
          <button
            v-for="lang in (['en', 'ru'] as const)"
            :key="lang"
            type="button"
            class="cursor-pointer rounded-md px-2.5 py-1 transition-colors duration-200"
            :class="localeStore.locale === lang
              ? 'font-medium text-white'
              : 'text-white/40 hover:text-white/70'"
            @click="localeStore.setLocale(lang as Locale)"
          >
            {{ lang === "en" ? "EN" : "RU" }}
          </button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-lg px-5 pb-16 pt-6 sm:px-8">
      <h1 class="mb-2 text-2xl font-bold tracking-tight sm:text-3xl">
        {{ t("apps.title") }}
      </h1>
      <p class="mb-1 text-sm text-white/45">
        {{ t("apps.subtitle") }}
      </p>
      <p class="mb-8 text-[12px] text-white/30">
        <template v-if="loading">{{ t("apps.loadingVersion") }}</template>
        <template v-else-if="version">v{{ version }}</template>
        <template v-else>{{ t("apps.versionFallback") }}</template>
      </p>

      <!-- Recommended for detected OS -->
      <section
        v-if="recommendedPlatform"
        class="mb-6 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.08] p-5"
      >
        <p class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-400/90">
          {{ t("apps.recommended") }}
        </p>
        <h2 class="mb-4 text-lg font-semibold">
          {{ platformLabel(recommendedPlatform) }}
        </h2>
        <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <a
            :href="urlFor(recommendedPlatform)"
            class="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-white px-5 text-sm font-semibold text-black transition-colors hover:bg-white/90"
            :class="{ 'pointer-events-none opacity-50': loading }"
          >
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {{ t("apps.download") }}
          </a>
          <a
            v-if="recommendedPlatform === 'android'"
            :href="playStoreUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex h-11 cursor-pointer items-center justify-center rounded-lg border border-white/15 bg-white/5 px-5 text-sm font-semibold text-white transition-colors hover:border-white/25 hover:bg-white/10"
          >
            {{ t("apps.googlePlay") }}
          </a>
        </div>
      </section>

      <section v-else class="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-5">
        <p class="text-sm text-white/50">{{ t("apps.pickPlatform") }}</p>
      </section>

      <!-- All platforms -->
      <h2 class="mb-3 text-sm font-medium text-white/50">
        {{ t("apps.allPlatforms") }}
      </h2>
      <ul class="space-y-2">
        <li
          v-for="platform in sortedPlatforms"
          :id="platform"
          :key="platform"
          class="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-4"
          :class="platform === recommendedPlatform ? 'border-white/20' : ''"
        >
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p class="text-[15px] font-semibold">{{ platformLabel(platform) }}</p>
              <p
                v-if="platform === recommendedPlatform"
                class="mt-0.5 text-[11px] text-emerald-400/80"
              >
                {{ t("apps.yourDevice") }}
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <a
                :href="urlFor(platform)"
                class="inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-white px-4 text-[13px] font-semibold text-black transition-colors hover:bg-white/90"
                :class="{ 'pointer-events-none opacity-50': loading }"
              >
                {{ t("apps.download") }}
              </a>
              <a
                v-if="platform === 'android'"
                :href="playStoreUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg border border-white/15 bg-transparent px-4 text-[13px] font-semibold text-white/80 transition-colors hover:border-white/25 hover:text-white"
              >
                {{ t("apps.googlePlay") }}
              </a>
            </div>
          </div>
        </li>
      </ul>

      <p class="mt-8 text-center text-[12px] text-white/25">
        <a
          :href="releasesPageUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="cursor-pointer underline-offset-2 hover:text-white/45 hover:underline"
        >
          {{ t("apps.githubReleases") }}
        </a>
        <span class="mx-2">·</span>
        <a
          :href="downloadLinks.github"
          target="_blank"
          rel="noopener noreferrer"
          class="cursor-pointer underline-offset-2 hover:text-white/45 hover:underline"
        >
          GitHub
        </a>
      </p>
    </main>
  </div>
</template>
