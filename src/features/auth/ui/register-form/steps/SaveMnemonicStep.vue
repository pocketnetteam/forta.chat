<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useI18n } from "@/shared/lib/i18n";

const props = defineProps<{
  profile: { name: string; language: string; about: string; image?: string };
}>();

const router = useRouter();
const { t } = useI18n();
const authStore = useAuthStore();

const confirmed = ref(false);
const registering = ref(false);
const error = ref("");
const copied = ref(false);

const copyMnemonic = async () => {
  if (!authStore.regMnemonic) return;
  try {
    await navigator.clipboard.writeText(authStore.regMnemonic);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Fallback: select text
  }
};

const handleRegister = async () => {
  if (!confirmed.value) return;
  registering.value = true;
  error.value = "";
  try {
    await authStore.register(props.profile);
    // Go straight to chat — the blocking overlay in App.vue handles the waiting state
    router.push({ name: "ChatPage" });
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("register.registrationFailed");
    registering.value = false;
  }
};
</script>

<template>
  <div class="flex flex-col">
    <!-- Warning text -->
    <p class="mb-4 text-[13px] leading-relaxed text-text-on-main-bg-color">
      {{ t("register.saveMnemonicWarning") }}
    </p>

    <!-- Mnemonic phrase -->
    <div class="mb-4 rounded-xl border border-neutral-grad-1 bg-neutral-grad-0/50 p-4">
      <p class="break-words font-mono text-sm leading-7 text-text-color">
        {{ authStore.regMnemonic }}
      </p>
    </div>

    <!-- Copy button -->
    <button
      type="button"
      class="mb-5 flex h-10 w-full cursor-pointer items-center justify-center rounded-xl bg-neutral-grad-0 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-1"
      @click="copyMnemonic"
    >
      <svg v-if="!copied" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="mr-2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
      </svg>
      <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="mr-2 text-color-good">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      {{ copied ? t("chatInfo.copied") : t("register.copyToClipboard") }}
    </button>

    <!-- Confirm checkbox -->
    <label class="mb-4 flex cursor-pointer items-start gap-2.5 text-[13px] text-text-color">
      <input
        v-model="confirmed"
        type="checkbox"
        class="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-color-bg-ac"
      />
      {{ t("register.confirmSaved") }}
    </label>

    <p v-if="error" class="mb-3 text-xs text-color-bad">{{ error }}</p>

    <!-- Register button -->
    <button
      :disabled="!confirmed || registering"
      class="flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-color-bg-ac text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1 disabled:cursor-default disabled:opacity-50"
      @click="handleRegister"
    >
      <Spinner v-if="registering" size="sm" class="mr-2" />
      {{ registering ? t("register.registering") : t("register.completeRegistration") }}
    </button>
  </div>
</template>
