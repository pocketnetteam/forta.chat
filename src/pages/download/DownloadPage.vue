<script setup lang="ts">
import { useI18n } from "@/shared/lib/i18n";
import { useLocaleStore } from "@/entities/locale";
import type { Locale } from "@/entities/locale";
import { downloadLinks } from "@/shared/config/download-links";

const { t } = useI18n();
const localeStore = useLocaleStore();
const currentYear = new Date().getFullYear();

const stats = computed(() => [
  { label: t("download.statUptime"), value: t("download.statUptimeVal") },
  { label: t("download.statEncryption"), value: t("download.statEncryptionVal") },
  { label: t("download.statServers"), value: t("download.statServersVal") },
  { label: t("download.statCost"), value: t("download.statCostVal") },
]);

const features = computed(() => [
  { title: t("download.featureAnonymity"), desc: t("download.featureAnonymityDesc") },
  { title: t("download.featureEncryption"), desc: t("download.featureEncryptionDesc") },
  { title: t("download.featureWallet"), desc: t("download.featureWalletDesc") },
  { title: t("download.featureChannels"), desc: t("download.featureChannelsDesc") },
  { title: t("download.featureCalls"), desc: t("download.featureCallsDesc") },
]);
</script>

<template>
  <div class="landing h-full overflow-y-auto bg-[#09090b] text-white">
    <!-- Nav -->
    <nav class="fade-in flex items-center justify-between px-6 py-5 sm:px-10">
      <div class="flex items-center gap-2.5">
        <img src="/forta-icon.png" alt="Forta Chat" class="h-8 w-8 object-contain" />
        <span class="text-base font-semibold tracking-tight">FortaChat</span>
      </div>
      <div class="flex items-center gap-1 text-[13px]">
        <button
          v-for="lang in (['en', 'ru'] as const)"
          :key="lang"
          class="cursor-pointer rounded-md px-2.5 py-1 transition-colors duration-200"
          :class="localeStore.locale === lang
            ? 'text-white font-medium'
            : 'text-white/40 hover:text-white/70'"
          @click="localeStore.setLocale(lang as Locale)"
        >
          {{ lang === "en" ? "EN" : "RU" }}
        </button>
      </div>
    </nav>

    <!-- Hero -->
    <section class="slide-up px-6 pb-24 pt-16 text-center sm:px-10 sm:pt-28">
      <span class="mb-5 inline-block rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-[11px] font-medium uppercase tracking-widest text-white/60">
        {{ t("download.privacyFirst") }}
      </span>
      <h1 class="mx-auto mb-6 max-w-3xl text-4xl font-bold leading-[1.08] tracking-tight sm:text-6xl lg:text-7xl">
        {{ t("download.heroTitle") }}
      </h1>
      <p class="mx-auto mb-12 max-w-lg text-[15px] leading-relaxed text-white/40">
        {{ t("download.heroSubtitle") }}
      </p>
      <div class="mx-auto flex max-w-xs flex-col gap-3 sm:max-w-none sm:flex-row sm:justify-center">
        <a
          href="/#/register"
          class="flex h-12 cursor-pointer items-center justify-center rounded-lg bg-white px-8 text-sm font-semibold text-black transition-all duration-200 hover:bg-white/90 hover:shadow-[0_0_24px_rgba(255,255,255,0.15)]"
        >
          {{ t("download.register") }}
        </a>
        <a
          :href="downloadLinks.androidApk"
          class="flex h-12 cursor-pointer items-center justify-center gap-2 rounded-lg border border-white/12 bg-white/5 px-8 text-sm font-semibold text-white transition-all duration-200 hover:border-white/25 hover:bg-white/10"
        >
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
          {{ t("download.downloadApk") }}
        </a>
      </div>
    </section>

    <!-- Zero-Knowledge -->
    <section class="slide-up-delay-1 px-6 pb-24 sm:px-10">
      <div class="mx-auto max-w-4xl">
        <h2 class="mb-2 text-center text-2xl font-bold tracking-tight sm:text-3xl">
          {{ t("download.zeroKnowledge") }}
        </h2>
        <p class="mb-10 text-center text-sm text-white/40">{{ t("download.zeroKnowledgeDesc") }}</p>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="card group rounded-xl border border-white/8 bg-white/[0.03] p-6 transition-all duration-300 hover:border-white/15 hover:bg-white/[0.05]">
            <div class="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-white/8 transition-colors duration-300 group-hover:bg-white/12">
              <svg class="h-5 w-5 text-white/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
              </svg>
            </div>
            <h3 class="mb-2 text-[15px] font-semibold">{{ t("download.identityAgnostic") }}</h3>
            <p class="text-[13px] leading-relaxed text-white/40">{{ t("download.identityAgnosticDesc") }}</p>
          </div>
          <div class="card group rounded-xl border border-white/8 bg-white/[0.03] p-6 transition-all duration-300 hover:border-white/15 hover:bg-white/[0.05]">
            <div class="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-white/8 transition-colors duration-300 group-hover:bg-white/12">
              <svg class="h-5 w-5 text-white/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
              </svg>
            </div>
            <h3 class="mb-2 text-[15px] font-semibold">{{ t("download.cryptoKeys") }}</h3>
            <p class="text-[13px] leading-relaxed text-white/40">{{ t("download.cryptoKeysDesc") }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Features -->
    <section class="slide-up-delay-2 px-6 pb-24 sm:px-10">
      <div class="mx-auto max-w-4xl">
        <h2 class="mb-2 text-center text-2xl font-bold tracking-tight sm:text-3xl">
          {{ t("download.featuresHeading") }}
        </h2>
        <p class="mb-10 text-center text-sm text-white/40">{{ t("download.featuresDesc") }}</p>
        <div class="space-y-3">
          <div
            v-for="(feature, i) in features"
            :key="feature.title"
            class="group flex cursor-default items-start gap-4 rounded-xl border border-white/8 bg-white/[0.03] px-5 py-4 transition-all duration-300 hover:border-white/15 hover:bg-white/[0.05]"
            :style="{ transitionDelay: `${i * 50}ms` }"
          >
            <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 transition-colors duration-300 group-hover:bg-emerald-500/25">
              <svg class="h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <div>
              <h3 class="text-[15px] font-semibold">{{ feature.title }}</h3>
              <p class="mt-0.5 text-[13px] leading-relaxed text-white/40">{{ feature.desc }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Borderless / Stats -->
    <section class="slide-up-delay-2 px-6 pb-24 sm:px-10">
      <div class="mx-auto max-w-4xl">
        <h2 class="mb-2 text-center text-2xl font-bold tracking-tight sm:text-3xl">
          {{ t("download.borderless") }}
        </h2>
        <p class="mx-auto mb-10 max-w-lg text-center text-sm leading-relaxed text-white/40">
          {{ t("download.borderlessDesc") }}
        </p>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          <div
            v-for="stat in stats"
            :key="stat.label"
            class="rounded-xl border border-white/8 bg-white/[0.03] p-5 text-center transition-all duration-300 hover:border-white/15"
          >
            <div class="mb-1 text-lg font-bold break-words sm:text-2xl">{{ stat.value }}</div>
            <div class="text-[11px] uppercase tracking-wider text-white/35">{{ stat.label }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- Download CTA -->
    <section class="slide-up-delay-2 px-6 pb-24 sm:px-10">
      <div class="mx-auto max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.02] p-8 text-center sm:p-10">
        <span class="mb-4 inline-block rounded-full bg-emerald-500/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-emerald-400">
          {{ t("download.availableNow") }}
        </span>
        <h2 class="mb-3 text-xl font-bold sm:text-2xl">{{ t("download.getOnAndroid") }}</h2>
        <p class="mb-7 text-sm text-white/40">{{ t("download.getOnAndroidDesc") }}</p>
        <a
          :href="downloadLinks.androidApk"
          class="mx-auto flex h-12 w-full max-w-xs cursor-pointer items-center justify-center gap-2 rounded-lg bg-white px-7 text-sm font-semibold text-black transition-all duration-200 hover:bg-white/90 hover:shadow-[0_0_24px_rgba(255,255,255,0.12)]"
        >
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
          {{ t("download.downloadApk") }}
        </a>
        <p class="mt-4 text-[11px] text-white/25">{{ t("download.versionInfo") }}</p>
      </div>
    </section>

    <!-- Footer -->
    <footer class="border-t border-white/5 px-6 py-6 sm:px-10">
      <div class="mx-auto flex max-w-4xl flex-col items-center gap-3 text-[11px] text-white/25 sm:flex-row sm:justify-between">
        <span>{{ t("download.footerRights").replace("{year}", String(currentYear)) }}</span>
        <div class="flex items-center gap-4">
          <a :href="downloadLinks.github" target="_blank" rel="noopener noreferrer" class="cursor-pointer transition-colors duration-200 hover:text-white/50">GitHub</a>
          <span>{{ t("download.footerPkoin") }}</span>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* ── Animations (respect reduced-motion) ── */
@media (prefers-reduced-motion: no-preference) {
  .fade-in {
    animation: fadeIn 0.6s ease-out both;
  }
  .slide-up {
    animation: slideUp 0.7s ease-out both;
  }
  .slide-up-delay-1 {
    animation: slideUp 0.7s ease-out 0.15s both;
  }
  .slide-up-delay-2 {
    animation: slideUp 0.7s ease-out 0.3s both;
  }
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(24px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
