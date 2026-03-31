<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useI18n } from "@/shared/lib/i18n";

const emit = defineEmits<{ done: [] }>();
const { t } = useI18n();
const authStore = useAuthStore();

const sanitizeSvg = (svg: string): string => {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/on\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "");
};

const captchaSvg = ref("");
const captchaText = ref("");
const loading = ref(true);
const submitting = ref(false);
const error = ref("");

const loadCaptcha = async (clearError = true) => {
  loading.value = true;
  if (clearError) error.value = "";
  captchaText.value = "";
  try {
    const result = await authStore.fetchCaptcha();
    // The API returns { id, img (SVG markup), done }
    captchaSvg.value = sanitizeSvg(result?.img || "");
    loading.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("register.captchaLoadFailed");
    loading.value = false;
  }
};

const handleSubmit = async () => {
  if (!captchaText.value.trim()) return;
  submitting.value = true;
  error.value = "";
  try {
    await authStore.submitCaptcha(captchaText.value.trim());
    emit("done");
  } catch {
    error.value = t("register.captchaIncorrect");
    submitting.value = false;
    await loadCaptcha(false);
  }
};

onMounted(loadCaptcha);
</script>

<template>
  <div class="flex flex-col">
    <!-- Loading state -->
    <div v-if="loading" class="flex items-center justify-center py-10">
      <Spinner size="lg" />
    </div>

    <template v-else>
      <!-- Captcha image -->
      <div
        v-if="captchaSvg"
        class="mb-4 flex justify-center overflow-hidden rounded-xl border border-neutral-grad-1 bg-white p-3"
        v-html="captchaSvg"
      />

      <form class="flex flex-col" @submit.prevent="handleSubmit">
        <input
          v-model="captchaText"
          type="text"
          :placeholder="t('register.captchaPlaceholder')"
          class="h-11 w-full rounded-xl border border-neutral-grad-1 bg-background-total-theme px-3.5 text-sm text-text-color outline-none transition-colors placeholder:text-neutral-grad-2 focus:border-color-bg-ac"
          autocomplete="off"
        />

        <p v-if="error" class="mt-2 text-xs text-color-bad">{{ error }}</p>

        <div class="mt-4 flex gap-2.5">
          <button
            type="button"
            :disabled="submitting"
            class="flex h-11 flex-1 cursor-pointer items-center justify-center rounded-xl bg-neutral-grad-0 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-1 disabled:cursor-default disabled:opacity-50"
            @click="loadCaptcha()"
          >
            {{ t("register.refreshCaptcha") }}
          </button>
          <button
            type="submit"
            :disabled="submitting || !captchaText.trim()"
            class="flex h-11 flex-1 cursor-pointer items-center justify-center rounded-xl bg-color-bg-ac text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1 disabled:cursor-default disabled:opacity-50"
          >
            <Spinner v-if="submitting" size="sm" class="mr-2" />
            {{ t("register.submit") }}
          </button>
        </div>
      </form>
    </template>
  </div>
</template>
