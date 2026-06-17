<script setup lang="ts">
import { ref, computed } from "vue";
import Modal from "@/shared/ui/modal/Modal.vue";
import type { CallProvider } from "@/shared/lib/local-db";

interface Props {
  show: boolean;
  /** Existing provider when editing; undefined when adding. */
  provider?: CallProvider;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  save: [value: Omit<CallProvider, "id">, id?: number];
  close: [];
}>();

const { t } = useI18n();

const label = ref(props.provider?.label ?? "");
const url = ref(props.provider?.urlTemplate ?? "");
const showError = ref(false);

const isValidUrl = computed(() => /^https?:\/\/.+/i.test(url.value.trim()));
const trimmedLabel = computed(() => label.value.trim());
const canSave = computed(() => isValidUrl.value && trimmedLabel.value.length > 0);

function onSave(): void {
  if (!canSave.value) {
    showError.value = true;
    return;
  }
  emit("save", { label: trimmedLabel.value, urlTemplate: url.value.trim() }, props.provider?.id);
}
</script>

<template>
  <Modal :show="props.show" :aria-label="t(provider ? 'settings.callProviders.editTitle' : 'settings.callProviders.addTitle')" @close="emit('close')">
    <h3 class="mb-5 text-base font-semibold text-text-color">
      {{ t(provider ? "settings.callProviders.editTitle" : "settings.callProviders.addTitle") }}
    </h3>

    <!-- Label -->
    <label class="mb-1.5 block text-xs font-medium text-text-on-main-bg-color">
      {{ t("settings.callProviders.label") }} <span class="text-color-bad">*</span>
    </label>
    <input
      v-model="label"
      type="text"
      :placeholder="t('settings.callProviders.labelPlaceholder')"
      class="w-full rounded-xl border bg-transparent px-3.5 py-2.5 text-sm text-text-color outline-none transition-colors focus:border-color-bg-ac"
      :class="showError && !trimmedLabel.length ? 'border-color-bad' : 'border-neutral-grad-2'"
    />
    <p v-if="showError && !trimmedLabel.length" class="mt-1.5 text-xs text-color-bad">{{ t("settings.callProviders.labelRequired") }}</p>

    <!-- URL -->
    <label class="mb-1.5 mt-4 block text-xs font-medium text-text-on-main-bg-color">{{ t("settings.callProviders.url") }}</label>
    <input
      v-model="url"
      type="text"
      inputmode="url"
      autocapitalize="off"
      autocomplete="off"
      :placeholder="t('settings.callProviders.urlPlaceholder')"
      class="w-full rounded-xl border bg-transparent px-3.5 py-2.5 text-sm text-text-color outline-none transition-colors focus:border-color-bg-ac"
      :class="showError && !isValidUrl ? 'border-color-bad' : 'border-neutral-grad-2'"
    />
    <p v-if="showError && !isValidUrl" class="mt-1.5 text-xs text-color-bad">{{ t("settings.callProviders.invalidUrl") }}</p>

    <!-- Actions -->
    <div class="mt-6 flex justify-end gap-2">
      <button
        type="button"
        class="rounded-xl px-4 py-2.5 text-sm font-medium text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        @click="emit('close')"
      >
        {{ t("settings.callProviders.cancel") }}
      </button>
      <button
        type="button"
        class="rounded-xl bg-color-bg-ac px-5 py-2.5 text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1 disabled:opacity-50"
        :disabled="!canSave"
        @click="onSave"
      >
        {{ t("settings.callProviders.save") }}
      </button>
    </div>
  </Modal>
</template>
