<script setup lang="ts">
import { BottomSheet } from "@/shared/ui/bottom-sheet";
import ProviderIcon from "./ProviderIcon.vue";
import type { CallOption } from "../model/call-action";

interface Props {
  show: boolean;
  options: CallOption[];
}

const props = defineProps<Props>();
const emit = defineEmits<{ pick: [option: CallOption]; close: [] }>();

const { t } = useI18n();
</script>

<template>
  <BottomSheet :show="props.show" :aria-label="t('call.picker.title')" @close="emit('close')">
    <h3 class="mb-3 text-base font-semibold text-text-color">{{ t("call.picker.title") }}</h3>
    <ul class="flex flex-col gap-1">
      <li v-for="(option, i) in props.options" :key="i">
        <button
          type="button"
          data-test="picker-option"
          :data-test-kind="option.type === 'native' ? 'native' : option.provider.kind"
          :data-test-native="option.type === 'native' ? 'true' : undefined"
          class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-neutral-grad-0"
          @click="emit('pick', option)"
        >
          <template v-if="option.type === 'native'">
            <span class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-color-bg-ac text-text-on-bg-ac-color" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
              </svg>
            </span>
            <span class="font-medium text-text-color">{{ t("call.fortaNative") }}</span>
          </template>
          <template v-else>
            <ProviderIcon :kind="option.provider.kind" />
            <span class="min-w-0">
              <span class="block truncate font-medium text-text-color">{{ option.provider.label }}</span>
              <span class="block truncate text-xs text-text-on-main-bg-color">
                {{ t(`settings.callProviders.kinds.${option.provider.kind}`) }}
              </span>
            </span>
          </template>
        </button>
      </li>
    </ul>
  </BottomSheet>
</template>
