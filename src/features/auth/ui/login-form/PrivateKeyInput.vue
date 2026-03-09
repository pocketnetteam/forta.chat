<script setup lang="ts">
import { useI18n } from "@/shared/lib/i18n";

interface Props {
  modelValue: string;
  error?: string;
}

defineProps<Props>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const { t } = useI18n();

const showKey = ref(false);
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="relative">
      <textarea
        :value="modelValue"
        :placeholder="t('auth.privateKeyPlaceholder')"
        rows="3"
        class="w-full resize-none rounded-xl border border-neutral-grad-1 bg-background-total-theme px-3.5 py-3 pr-14 text-sm leading-relaxed text-text-color outline-none transition-colors placeholder:text-neutral-grad-2 focus:border-color-bg-ac"
        :class="{ 'private-key-masked': !showKey }"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      />
      <button
        type="button"
        class="absolute right-3 top-3 cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium text-color-txt-ac transition-colors hover:bg-color-bg-ac/10"
        @click="showKey = !showKey"
      >
        {{ showKey ? t("auth.hide") : t("auth.show") }}
      </button>
    </div>
    <p v-if="error" class="text-xs text-color-bad">{{ error }}</p>
  </div>
</template>

<style scoped>
.private-key-masked {
  -webkit-text-security: disc;
}
</style>
