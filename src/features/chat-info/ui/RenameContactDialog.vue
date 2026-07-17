<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from "vue";

interface Props {
  /** Raw Bastyon address (DM) or hex-encoded member ID (group). The chat-store
   *  alias action accepts either form and normalizes internally. */
  address: string;
  /** Current alias text (empty/null = no alias set). */
  currentAlias: string | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  save: [alias: string];
  remove: [];
  close: [];
}>();

const { t } = useI18n();
const alias = ref(props.currentAlias ?? "");
const inputRef = ref<HTMLInputElement | null>(null);

// Autofocus on mount + when address changes (reusing dialog for another member).
const focusInput = () => {
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
};

onMounted(focusInput);
watch(() => props.address, () => {
  alias.value = props.currentAlias ?? "";
  focusInput();
});

const onSave = () => {
  const trimmed = alias.value.trim();
  if (trimmed) emit("save", trimmed);
  else emit("remove");
};

const onRemove = () => emit("remove");
const onCancel = () => emit("close");
</script>

<template>
  <div
    class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
    @click.self="onCancel"
  >
    <div class="w-full max-w-sm rounded-xl bg-background-total-theme p-5 shadow-xl">
      <h3 class="mb-3 text-base font-semibold text-text-color">{{ t("contact.renameTitle") }}</h3>
      <input
        ref="inputRef"
        v-model="alias"
        type="text"
        :maxlength="64"
        :placeholder="t('contact.aliasPlaceholder')"
        class="w-full rounded-lg bg-chat-input-bg px-3 py-2 text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
        @keyup.enter="onSave"
        @keyup.escape="onCancel"
      />
      <p class="mt-2 text-xs text-text-on-main-bg-color">{{ t("contact.aliasHint") }}</p>
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <button
          v-if="currentAlias"
          class="rounded-lg px-3 py-2 text-sm font-medium text-color-bad transition-colors hover:bg-neutral-grad-0"
          @click="onRemove"
        >
          {{ t("contact.removeAlias") }}
        </button>
        <button
          class="rounded-lg px-3 py-2 text-sm font-medium text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
          @click="onCancel"
        >
          {{ t("info.cancel") }}
        </button>
        <button
          class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1"
          @click="onSave"
        >
          {{ t("contact.save") }}
        </button>
      </div>
    </div>
  </div>
</template>
