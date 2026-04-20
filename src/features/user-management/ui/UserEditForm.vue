<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useUserStore } from "@/entities/user/model";
import { useLocaleStore } from "@/entities/locale";
import type { Locale } from "@/entities/locale";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { fileToBase64, uploadImage } from "@/shared/lib/upload-image";

const authStore = useAuthStore();
const userStore = useUserStore();
const localeStore = useLocaleStore();
const { t } = useI18n();

const form = ref({
  name: authStore.userInfo?.name ?? "",
  about: authStore.userInfo?.about ?? "",
  site: authStore.userInfo?.site ?? "",
  language: authStore.userInfo?.language ?? "",
});

const avatarUrl = ref(authStore.userInfo?.image ?? "");
const avatarUploading = ref(false);
const avatarError = ref("");
const saveError = ref("");

// Re-sync the form fields when userInfo resolves (right after registration
// userInfo is initially undefined and arrives async). Without this watch the
// form stays empty while authStore.userInfo is set, and hasChanges compares
// typed input to undefined fields, blocking Save forever.
watch(
  () => authStore.userInfo,
  (info) => {
    if (!info) return;
    // Only overwrite fields the user hasn't edited yet (still empty).
    // Initial population fills from info; subsequent changes preserve
    // the user's edits while letting delayed fields populate.
    if (!form.value.name) form.value.name = info.name ?? "";
    if (!form.value.about) form.value.about = info.about ?? "";
    if (!form.value.site) form.value.site = info.site ?? "";
    if (!form.value.language) form.value.language = info.language ?? "";
    if (!avatarUrl.value) avatarUrl.value = info.image ?? "";
  },
  { immediate: true, deep: true },
);

const aboutMaxLength = 140;
const aboutCount = computed(() => form.value.about.length);

const hasChanges = computed(() => {
  const info = authStore.userInfo;
  if (!info) {
    // userInfo not loaded yet (e.g. right after fresh registration).
    // Treat any user input as a change so Save becomes enabled instead of
    // the old buggy `return false` that left Save disabled forever.
    return (
      (form.value.name ?? "").trim().length > 0 ||
      (form.value.about ?? "").trim().length > 0 ||
      (form.value.site ?? "").trim().length > 0 ||
      (form.value.language ?? "").trim().length > 0 ||
      avatarUrl.value.length > 0
    );
  }
  return (
    form.value.name !== (info.name ?? "") ||
    form.value.about !== (info.about ?? "") ||
    form.value.site !== (info.site ?? "") ||
    form.value.language !== (info.language ?? "") ||
    avatarUrl.value !== (info.image ?? "")
  );
});

const saveSuccess = ref(false);

const handleSave = async () => {
  saveError.value = "";
  try {
    const result = await authStore.editUserData({
      ...(authStore.userInfo ?? {
        address: authStore.address ?? "",
        name: "",
        about: "",
        site: "",
        language: "",
        image: "",
        addresses: [],
        ref: null,
        keys: [],
      }),
      name: form.value.name,
      about: form.value.about,
      site: form.value.site,
      language: form.value.language,
      image: avatarUrl.value,
    } as import("@/entities/auth/model/types").UserData);

    // editUserData may return a structured { success, reason } envelope from
    // app-initializer; surface a user-visible error if it did.
    if (result && typeof result === "object" && "success" in result && (result as { success: boolean }).success === false) {
      saveError.value = t("profile.saveFailed");
      return;
    }

    // Update the user store cache so avatar/name reflect immediately
    if (authStore.address) {
      userStore.setUser(authStore.address, {
        address: authStore.address,
        name: form.value.name,
        about: form.value.about,
        image: avatarUrl.value,
        site: form.value.site,
        language: form.value.language,
      });
    }
    saveSuccess.value = true;
    setTimeout(() => (saveSuccess.value = false), 2000);
  } catch (err) {
    console.error("[UserEditForm] handleSave failed:", err);
    saveError.value =
      err instanceof Error ? err.message : t("profile.saveFailed");
  }
};

// Avatar upload
const fileInput = ref<HTMLInputElement>();
const handleAvatarClick = () => fileInput.value?.click();
const handleAvatarChange = async (e: Event) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  avatarError.value = "";
  try {
    const base64 = await fileToBase64(file);
    avatarUrl.value = base64; // local preview
    avatarUploading.value = true;
    const url = await uploadImage(base64);
    avatarUrl.value = url;
  } catch (err) {
    avatarError.value = err instanceof Error ? err.message : t("profile.avatarError");
    avatarUrl.value = authStore.userInfo?.image ?? "";
  } finally {
    avatarUploading.value = false;
    // Reset file input so re-selecting same file triggers change
    if (fileInput.value) fileInput.value.value = "";
  }
};

const currentUser = computed(() =>
  authStore.address ? userStore.getUser(authStore.address) : undefined,
);

// Load user profile eagerly
watch(
  () => authStore.address,
  (addr) => { if (addr) userStore.loadUserIfMissing(addr); },
  { immediate: true },
);
</script>

<template>
  <div class="flex flex-col">
    <!-- Avatar section -->
    <div class="flex flex-col items-center pb-6 pt-2">
      <div class="group relative cursor-pointer" @click="handleAvatarClick">
        <Avatar
          :src="avatarUrl || currentUser?.image"
          :name="currentUser?.name || authStore.address || 'User'"
          size="xl"
        />
        <div
          class="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 transition-opacity"
          :class="avatarUploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
        >
          <svg v-if="!avatarUploading" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
            <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          <Spinner v-else size="sm" class="text-white" />
        </div>
      </div>
      <p v-if="avatarError" class="mt-1 text-xs text-color-bad">{{ avatarError }}</p>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        class="hidden"
        @change="handleAvatarChange"
      />
    </div>

    <!-- Form fields -->
    <form class="flex flex-col gap-5" @submit.prevent="handleSave">
      <!-- Name -->
      <div class="rounded-xl bg-background-secondary-theme px-4">
        <div class="flex items-center gap-3 border-b border-neutral-grad-0 py-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
          </svg>
          <div class="flex-1">
            <label class="text-xs text-text-on-main-bg-color">{{ t("profile.name") }}</label>
            <input
              v-model="form.name"
              type="text"
              :placeholder="t('profile.displayName')"
              class="block w-full bg-transparent text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
            />
          </div>
        </div>
        <div class="flex items-start gap-3 py-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="mt-0.5 shrink-0 text-text-on-main-bg-color">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <div class="flex-1">
            <div class="flex items-center justify-between">
              <label class="text-xs text-text-on-main-bg-color">{{ t("profile.bio") }}</label>
              <span
                class="text-[10px]"
                :class="aboutCount > aboutMaxLength ? 'text-color-bad' : 'text-text-on-main-bg-color'"
              >{{ aboutCount }}/{{ aboutMaxLength }}</span>
            </div>
            <textarea
              v-model="form.about"
              :placeholder="t('profile.bioPlaceholder')"
              rows="2"
              :maxlength="aboutMaxLength"
              class="block w-full resize-none bg-transparent text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
            />
          </div>
        </div>
      </div>

      <!-- Additional info -->
      <div class="rounded-xl bg-background-secondary-theme px-4">
        <div class="flex items-center gap-3 border-b border-neutral-grad-0 py-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
            <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <div class="flex-1">
            <label class="text-xs text-text-on-main-bg-color">{{ t("profile.website") }}</label>
            <input
              v-model="form.site"
              type="text"
              placeholder="https://..."
              class="block w-full bg-transparent text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
            />
          </div>
        </div>
        <div class="flex items-center gap-3 py-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
            <path d="M5 8l6 6" /><path d="M4 14l6 6" />
            <rect x="2" y="2" width="8" height="8" rx="2" /><path d="M14 4h6v6" /><path d="M14 10l6-6" />
          </svg>
          <div class="flex-1">
            <label class="text-xs text-text-on-main-bg-color">{{ t("profile.language") }}</label>
            <select
              :value="localeStore.locale"
              class="block w-full bg-transparent text-sm text-text-color outline-none"
              @change="localeStore.setLocale(($event.target as HTMLSelectElement).value as Locale)"
            >
              <option value="en">{{ t("locale.en") }}</option>
              <option value="ru">{{ t("locale.ru") }}</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Address (read-only) -->
      <div v-if="authStore.address" class="rounded-xl bg-background-secondary-theme px-4">
        <div class="flex items-center gap-3 py-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <div class="flex-1 min-w-0">
            <label class="text-xs text-text-on-main-bg-color">{{ t("profile.address") }}</label>
            <p class="break-all text-sm text-text-color/60">{{ authStore.address }}</p>
          </div>
        </div>
      </div>

      <!-- Save error (structured error from editUserData: timeout / network / rejected) -->
      <p v-if="saveError" class="text-center text-xs text-color-bad">{{ saveError }}</p>

      <!-- Save button -->
      <button
        type="submit"
        :disabled="authStore.isEditingUserData || !hasChanges || avatarUploading"
        class="mx-auto flex h-11 w-full max-w-xs items-center justify-center rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
        :class="saveSuccess
          ? 'bg-color-good text-white'
          : 'bg-color-bg-ac text-text-on-bg-ac-color hover:opacity-90'"
      >
        <template v-if="saveSuccess">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="mr-1.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {{ t("profile.saved") }}
        </template>
        <template v-else-if="authStore.isEditingUserData">
          {{ t("profile.saving") }}
        </template>
        <template v-else>
          {{ t("profile.saveChanges") }}
        </template>
      </button>
    </form>
  </div>
</template>
