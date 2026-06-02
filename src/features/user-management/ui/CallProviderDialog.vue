<script setup lang="ts">
import { ref, computed } from "vue";
import Modal from "@/shared/ui/modal/Modal.vue";
import { Toggle } from "@/shared/ui/toggle";
import type { CallProvider } from "@/shared/lib/local-db";
import type { CallProviderKind } from "@/entities/chat/model/types";
import ProviderIcon from "@/features/video-calls/ui/ProviderIcon.vue";

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

const KINDS: CallProviderKind[] = ["zoom", "google_meet", "jitsi", "custom"];

const kind = ref<CallProviderKind>(props.provider?.kind ?? "zoom");
const label = ref(props.provider?.label ?? "");
const url = ref(props.provider?.urlTemplate ?? "");
const isDefault = ref(props.provider?.isDefault ?? false);
const showError = ref(false);

const isValidUrl = computed(() => /^https?:\/\/.+/i.test(url.value.trim()));
const trimmedLabel = computed(() => label.value.trim());
const canSave = computed(() => isValidUrl.value && trimmedLabel.value.length > 0);

function onSave(): void {
  if (!canSave.value) {
    showError.value = true;
    return;
  }
  emit(
    "save",
    {
      kind: kind.value,
      label: trimmedLabel.value,
      urlTemplate: url.value.trim(),
      isDefault: isDefault.value,
    },
    props.provider?.id,
  );
}
</script>

<template>
  <Modal :show="props.show" :aria-label="t(provider ? 'settings.callProviders.editTitle' : 'settings.callProviders.addTitle')" @close="emit('close')">
    <h3 class="mb-4 text-base font-semibold text-text-color">
      {{ t(provider ? "settings.callProviders.editTitle" : "settings.callProviders.addTitle") }}
    </h3>

    <!-- Kind selector -->
    <label class="mb-1 block text-xs text-text-on-main-bg-color">{{ t("settings.callProviders.kind") }}</label>
    <div class="mb-4 grid grid-cols-2 gap-2">
      <button
        v-for="k in KINDS"
        :key="k"
        type="button"
        class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
        :class="kind === k ? 'border-color-bg-ac bg-color-bg-ac/10 text-text-color' : 'border-neutral-grad-2 text-text-on-main-bg-color hover:bg-neutral-grad-0'"
        @click="kind = k"
      >
        <ProviderIcon :kind="k" size-class="h-6 w-6 text-xs" />
        {{ t(`settings.callProviders.kinds.${k}`) }}
      </button>
    </div>

    <!-- Label -->
    <label class="mb-1 block text-xs text-text-on-main-bg-color">{{ t("settings.callProviders.label") }}</label>
    <input
      v-model="label"
      type="text"
      :placeholder="t('settings.callProviders.labelPlaceholder')"
      class="mb-4 w-full rounded-lg border border-neutral-grad-2 bg-transparent px-3 py-2 text-sm text-text-color outline-none focus:border-color-bg-ac"
    />

    <!-- URL -->
    <label class="mb-1 block text-xs text-text-on-main-bg-color">{{ t("settings.callProviders.url") }}</label>
    <input
      v-model="url"
      type="url"
      inputmode="url"
      :placeholder="t('settings.callProviders.urlPlaceholder')"
      class="w-full rounded-lg border bg-transparent px-3 py-2 text-sm text-text-color outline-none focus:border-color-bg-ac"
      :class="showError && !isValidUrl ? 'border-color-bad' : 'border-neutral-grad-2'"
    />
    <p v-if="showError && !isValidUrl" class="mt-1 text-xs text-color-bad">{{ t("settings.callProviders.invalidUrl") }}</p>

    <!-- Default toggle -->
    <label class="mt-4 flex items-center justify-between">
      <span class="text-sm text-text-color">{{ t("settings.callProviders.setDefaultOnSave") }}</span>
      <Toggle :model-value="isDefault" @update:model-value="(v: boolean) => (isDefault = v)" />
    </label>

    <!-- Actions -->
    <div class="mt-6 flex justify-end gap-2">
      <button
        type="button"
        class="rounded-lg px-4 py-2 text-sm font-medium text-text-on-main-bg-color hover:bg-neutral-grad-0"
        @click="emit('close')"
      >
        {{ t("settings.callProviders.cancel") }}
      </button>
      <button
        type="button"
        class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-text-on-bg-ac-color hover:bg-color-bg-ac-1 disabled:opacity-50"
        :disabled="!canSave"
        @click="onSave"
      >
        {{ t("settings.callProviders.save") }}
      </button>
    </div>
  </Modal>
</template>
