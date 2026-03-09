<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useI18n } from "@/shared/lib/i18n";
import { useLocaleStore } from "@/entities/locale";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { fileToBase64, uploadImage } from "@/shared/lib/upload-image";

const emit = defineEmits<{
  done: [data: { name: string; language: string; about: string; image?: string }]
}>();
const { t } = useI18n();
const authStore = useAuthStore();
const localeStore = useLocaleStore();

const name = ref("");
const about = ref("");
const loading = ref(false);
const error = ref("");

// Avatar
const avatarPreview = ref("");
const avatarUrl = ref("");
const avatarUploading = ref(false);
const avatarFileInput = ref<HTMLInputElement>();

const handleAvatarClick = () => avatarFileInput.value?.click();
const handleAvatarChange = async (e: Event) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const base64 = await fileToBase64(file);
    avatarPreview.value = base64;
    avatarUploading.value = true;
    avatarUrl.value = await uploadImage(base64);
  } catch (err) {
    avatarPreview.value = "";
    avatarUrl.value = "";
    error.value = err instanceof Error ? err.message : t("profile.avatarError");
  } finally {
    avatarUploading.value = false;
    if (avatarFileInput.value) avatarFileInput.value.value = "";
  }
};

const handleSubmit = async () => {
  if (!name.value.trim()) return;
  loading.value = true;
  error.value = "";
  try {
    // Generate keys and find proxy silently
    authStore.generateRegistrationKeys();
    await authStore.findRegistrationProxy();
    emit("done", {
      name: name.value.trim(),
      language: localeStore.locale,
      about: about.value.trim(),
      ...(avatarUrl.value ? { image: avatarUrl.value } : {}),
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("register.initError");
    loading.value = false;
  }
};
</script>

<template>
  <form class="flex flex-col" @submit.prevent="handleSubmit">
    <!-- Avatar -->
    <div class="mb-5 flex flex-col items-center">
      <div class="group relative cursor-pointer" @click="handleAvatarClick">
        <Avatar
          :src="avatarPreview"
          :name="name || '?'"
          size="xl"
        />
        <div
          class="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 transition-opacity"
          :class="avatarUploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
        >
          <svg v-if="!avatarUploading" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
            <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          <Spinner v-else size="sm" class="text-white" />
        </div>
      </div>
      <span class="mt-1.5 text-[11px] text-text-on-main-bg-color/70">{{ t("register.avatarOptional") }}</span>
      <input
        ref="avatarFileInput"
        type="file"
        accept="image/*"
        class="hidden"
        @change="handleAvatarChange"
      />
    </div>

    <!-- Fields -->
    <div class="flex flex-col gap-3.5">
      <div>
        <label class="mb-1 block text-[13px] font-medium text-text-on-main-bg-color">
          {{ t("register.displayName") }}
        </label>
        <input
          v-model="name"
          type="text"
          :placeholder="t('register.namePlaceholder')"
          class="h-11 w-full rounded-xl border border-neutral-grad-1 bg-background-total-theme px-3.5 text-sm text-text-color outline-none transition-colors placeholder:text-neutral-grad-2 focus:border-color-bg-ac"
          maxlength="20"
          required
          :disabled="loading"
        />
      </div>

      <div>
        <label class="mb-1 block text-[13px] font-medium text-text-on-main-bg-color">
          {{ t("register.aboutOptional") }}
        </label>
        <textarea
          v-model="about"
          :placeholder="t('register.aboutPlaceholder')"
          rows="2"
          class="w-full resize-none rounded-xl border border-neutral-grad-1 bg-background-total-theme px-3.5 py-2.5 text-sm leading-relaxed text-text-color outline-none transition-colors placeholder:text-neutral-grad-2 focus:border-color-bg-ac"
          :disabled="loading"
        />
      </div>
    </div>

    <p v-if="error" class="mt-3 text-xs text-color-bad">{{ error }}</p>

    <!-- Submit -->
    <button
      type="submit"
      :disabled="!name.trim() || loading"
      class="mt-5 flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-color-bg-ac text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1 disabled:cursor-default disabled:opacity-50"
    >
      <Spinner v-if="loading" size="sm" class="mr-2" />
      {{ loading ? t("register.preparingAccount") : t("register.continue") }}
    </button>
  </form>
</template>
