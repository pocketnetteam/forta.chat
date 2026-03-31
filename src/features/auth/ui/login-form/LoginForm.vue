<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useI18n } from "@/shared/lib/i18n";
import { isNative } from "@/shared/lib/platform";
import PrivateKeyInput from "./PrivateKeyInput.vue";

const router = useRouter();
const authStore = useAuthStore();
const { t, locale } = useI18n();

const cryptoCredential = ref("");
const errorMessage = ref("");

const HELP_PATH = `/help/how-to-get-private-key.html`;
const openHelp = () => {
  const langParam = `?lang=${locale.value}`;
  const url = isNative
    ? `https://forta.chat${HELP_PATH}${langParam}`
    : `${window.location.origin}${HELP_PATH}${langParam}`;
  window.open(url, "_blank");
};

const handleLogin = async () => {
  errorMessage.value = "";

  if (!cryptoCredential.value.trim()) {
    errorMessage.value = t("auth.enterKeyError");
    return;
  }

  const result = await authStore.login(cryptoCredential.value.trim());
  if (result?.error) {
    errorMessage.value = result.error;
  } else {
    router.push({ name: "ChatPage" });
  }
};
</script>

<template>
  <div class="flex flex-col items-center">
    <!-- Icon -->
    <div
      class="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-color-bg-ac/10"
    >
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" class="text-color-txt-ac">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke="currentColor" stroke-width="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" />
      </svg>
    </div>

    <!-- Heading -->
    <h1 class="mb-1 text-xl font-semibold text-text-color">
      {{ t("auth.signIn") }}
    </h1>
    <p class="mb-6 text-center text-[13px] leading-relaxed text-text-on-main-bg-color">
      {{ t("auth.enterKey") }}
    </p>

    <!-- Form -->
    <form class="flex w-full flex-col gap-4" @submit.prevent="handleLogin">
      <div>
        <div class="mb-1.5 flex items-center justify-between">
          <label class="text-sm font-medium text-text-color">
            {{ t("auth.privateKeyLabel") }}
          </label>
          <button
            type="button"
            :aria-label="t('auth.howToFindKey')"
            class="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-neutral-grad-1 text-[11px] font-semibold leading-none text-text-on-main-bg-color transition-colors hover:border-color-bg-ac hover:text-color-txt-ac"
            @click="openHelp"
          >
            ?
          </button>
        </div>
        <PrivateKeyInput
          v-model="cryptoCredential"
          :error="errorMessage"
        />
      </div>

      <button
        type="submit"
        :disabled="authStore.isLoggingIn"
        class="flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-color-bg-ac text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1 disabled:cursor-default disabled:opacity-50"
      >
        <Spinner v-if="authStore.isLoggingIn" size="sm" class="mr-2" />
        {{ authStore.isLoggingIn ? t("auth.signingIn") : t("auth.signIn") }}
      </button>
    </form>

    <!-- Security hint -->
    <p class="mt-4 text-center text-[11px] text-text-on-main-bg-color/70">
      {{ t("auth.keyNeverLeaves") }}
    </p>

    <!-- Register link -->
    <p class="mt-6 text-center text-[13px] text-text-on-main-bg-color">
      {{ t("register.noAccount") }}
      {{ " " }}
      <router-link
        :to="{ name: 'RegisterPage' }"
        class="font-medium text-color-txt-ac hover:underline"
      >
        {{ t("register.createAccount") }}
      </router-link>
    </p>
  </div>
</template>
