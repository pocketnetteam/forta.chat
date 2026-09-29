<script setup lang="ts">
import Modal from "@/shared/ui/modal/Modal.vue";
import { useAuthStore } from "@/entities/auth";

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const authStore = useAuthStore();

const credential = ref("");
const error = ref<string | null>(null);
const loading = ref(false);

const handleSubmit = async () => {
  if (!credential.value.trim() || loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    const result = await authStore.addAccount(credential.value.trim());
    if (result.error) {
      error.value = result.error;
    } else {
      emit("close");
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
};

// Reset state when modal opens
watch(() => props.show, (val) => {
  if (val) {
    credential.value = "";
    error.value = null;
    loading.value = false;
  }
});
</script>

<template>
  <Modal :show="props.show" :aria-label="t('settings.addAccount')" @close="emit('close')">
    <div class="flex flex-col gap-4">
      <!-- Header -->
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold text-text-color">
          {{ t("settings.addAccount") }}
        </h2>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0"
          @click="emit('close')"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <!-- Form -->
      <form @submit.prevent="handleSubmit" class="flex flex-col gap-3">
        <label class="text-sm text-text-on-main-bg-color">
          {{ t("auth.enterKeyOrMnemonic") }}
        </label>
        <textarea
          v-model="credential"
          :placeholder="t('auth.keyPlaceholder')"
          rows="3"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          class="w-full resize-none rounded-lg border border-neutral-grad-0 bg-background-secondary-theme p-3 text-sm text-text-color outline-none transition-colors focus:border-color-bg-ac"
          :disabled="loading"
        />

        <!-- Error -->
        <p v-if="error" class="text-sm text-color-bad">
          {{ error }}
        </p>

        <!-- Submit -->
        <button
          type="submit"
          :disabled="!credential.trim() || loading"
          class="mt-1 w-full rounded-lg bg-color-bg-ac px-4 py-2.5 text-sm font-medium text-white transition-opacity disabled:opacity-50"
        >
          {{ loading ? t("common.loading") : t("auth.login") }}
        </button>
      </form>
    </div>
  </Modal>
</template>
