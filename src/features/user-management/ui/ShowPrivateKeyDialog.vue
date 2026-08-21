<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useAuthStore } from "@/entities/auth";
import Modal from "@/shared/ui/modal/Modal.vue";
import { copyToClipboard } from "@/shared/lib/share-link";
import { useToast } from "@/shared/lib/use-toast";
import { useI18n } from "@/shared/lib/i18n";

interface Props {
  show: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { toast } = useToast();
const authStore = useAuthStore();

type Step = "confirm" | "reveal";
const step = ref<Step>("confirm");
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const privateKey = computed(() => authStore.privateKey);

watch(
  () => props.show,
  (visible) => {
    if (visible) {
      step.value = "confirm";
      copied.value = false;
      if (copiedTimer) {
        clearTimeout(copiedTimer);
        copiedTimer = null;
      }
    }
  },
);

function handleClose(): void {
  step.value = "confirm";
  copied.value = false;
  if (copiedTimer) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
  emit("close");
}

function handleConfirmYes(): void {
  if (!privateKey.value) {
    handleClose();
    return;
  }
  step.value = "reveal";
}

async function handleCopy(): Promise<void> {
  const key = privateKey.value;
  if (!key) return;
  try {
    await copyToClipboard(key);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
      copiedTimer = null;
    }, 2000);
  } catch {
    toast(t("chat.copyFailed"), "error");
  }
}

onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <Modal
    :show="props.show"
    :aria-label="step === 'confirm' ? t('settings.showPrivateKeyConfirm') : t('settings.privateKeyLabel')"
    @close="handleClose"
  >
    <!-- Confirm step -->
    <template v-if="step === 'confirm'">
      <p class="mb-6 text-sm leading-relaxed text-text-color">
        {{ t("settings.showPrivateKeyConfirm") }}
      </p>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-xl px-4 py-2.5 text-sm font-medium text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
          @click="handleClose"
        >
          {{ t("settings.showPrivateKeyNo") }}
        </button>
        <button
          type="button"
          class="rounded-xl bg-color-bg-ac px-4 py-2.5 text-sm font-medium text-text-on-bg-ac-color transition-opacity hover:opacity-90"
          @click="handleConfirmYes"
        >
          {{ t("settings.showPrivateKeyYes") }}
        </button>
      </div>
    </template>

    <!-- Reveal step -->
    <template v-else>
      <p class="mb-3 text-sm font-medium leading-relaxed text-text-color">
        {{ t("settings.privateKeyIsPassword") }}
      </p>
      <p class="mb-5 text-[13px] leading-relaxed text-text-on-main-bg-color">
        {{ t("settings.privateKeyImportant") }}
      </p>

      <label class="mb-1.5 block text-xs font-medium text-text-on-main-bg-color">
        {{ t("settings.privateKeyLabel") }}
      </label>
      <div class="mb-5 rounded-xl border border-neutral-grad-1 bg-neutral-grad-0/50 p-4">
        <p class="select-text break-all font-mono text-sm leading-6 text-text-color">
          {{ privateKey }}
        </p>
      </div>

      <button
        type="button"
        class="flex h-10 w-full cursor-pointer items-center justify-center rounded-xl bg-neutral-grad-0 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-1"
        @click="handleCopy"
      >
        <svg
          v-if="!copied"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="mr-2"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
        <svg
          v-else
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          class="mr-2 text-color-good"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        {{ copied ? t("chatInfo.copied") : t("settings.copyPrivateKey") }}
      </button>
    </template>
  </Modal>
</template>
