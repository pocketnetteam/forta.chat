<script setup lang="ts">
import { computed } from "vue";
import { useI18n, type TranslationKey } from "@/shared/lib/i18n";
import { useSendErrorBus } from "../model/send-error-bus";
import { sendErrorI18nKey, type SendErrorKind } from "../model/send-errors";

const { t } = useI18n();
const { error, clear } = useSendErrorBus();

const visible = computed(() => error.value !== null);
// All kinds in SendErrorKind have a matching `errors.send.<kind>` key in en.ts,
// so the cast is safe — but TranslationKey is a literal-union type and TS
// cannot derive it from a runtime kind string without the cast.
const labelKey = computed<TranslationKey>(() =>
  error.value
    ? (sendErrorI18nKey(error.value.kind as SendErrorKind) as TranslationKey)
    : ("errors.send.unknown" as TranslationKey),
);
const retryable = computed(() => !!error.value?.retry && error.value.retryable);

/** Banner stays open after a retry triggers — the new send will either
 *  succeed (and the next reportSendError will overwrite it on failure) or
 *  emit a fresh error here. Closing immediately on tap would hide the
 *  second failure and re-introduce the original silent-fail bug. */
const onRetry = async () => {
  const current = error.value;
  if (!current?.retry) return;
  try {
    await current.retry();
  } catch {
    // Retry path itself failed: leave the banner so the user can try again.
  }
};

const onDismiss = () => {
  const current = error.value;
  if (current) clear(current.id);
  else clear();
};
</script>

<template>
  <Transition name="send-error-fade">
    <div
      v-if="visible && error"
      class="pointer-events-auto mx-2 mb-2 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
      role="alert"
      :data-error-kind="error.kind"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span class="flex-1 leading-snug">{{ t(labelKey) }}</span>
      <button
        v-if="retryable"
        type="button"
        class="rounded-md px-2 py-1 text-xs font-medium underline-offset-2 hover:underline"
        @click="onRetry"
      >
        {{ t("errors.send.retry") }}
      </button>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-xs font-medium opacity-70 hover:opacity-100"
        :aria-label="t('errors.send.dismiss')"
        @click="onDismiss"
      >
        ✕
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.send-error-fade-enter-active,
.send-error-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.send-error-fade-enter-from,
.send-error-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
