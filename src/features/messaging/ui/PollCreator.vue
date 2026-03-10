<script setup lang="ts">
import { ref } from "vue";

const { t } = useI18n();

const emit = defineEmits<{
  create: [question: string, options: string[]];
  close: [];
}>();

const question = ref("");
const options = ref(["", ""]);

const addOption = () => {
  if (options.value.length < 10) {
    options.value.push("");
  }
};

const removeOption = (index: number) => {
  if (options.value.length > 2) {
    options.value.splice(index, 1);
  }
};

const canCreate = () => {
  return question.value.trim().length > 0
    && options.value.filter(o => o.trim().length > 0).length >= 2;
};

const handleCreate = () => {
  if (!canCreate()) return;
  const validOptions = options.value.map(o => o.trim()).filter(o => o.length > 0);
  emit("create", question.value.trim(), validOptions);
};
</script>

<template>
  <Teleport to="body">
    <!-- Backdrop -->
    <div class="fixed inset-0 z-50 bg-black/40" @click="emit('close')" />

    <!-- Panel -->
    <div class="fixed bottom-0 left-0 right-0 z-50 mx-auto max-w-lg rounded-t-2xl bg-background-total-theme p-5 shadow-xl">
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-base font-semibold text-text-color">Create Poll</h3>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0"
          @click="emit('close')"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Question -->
      <input
        v-model="question"
        type="text"
        :placeholder="t('poll.askQuestion')"
        class="mb-3 w-full rounded-lg bg-chat-input-bg px-3 py-2.5 text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
        maxlength="200"
      />

      <!-- Options -->
      <div class="mb-3 flex flex-col gap-2">
        <div v-for="(_, index) in options" :key="index" class="flex items-center gap-2">
          <input
            v-model="options[index]"
            type="text"
            :placeholder="t('poll.option', { n: index + 1 })"
            class="flex-1 rounded-lg bg-chat-input-bg px-3 py-2 text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
            maxlength="100"
          />
          <button
            v-if="options.length > 2"
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0"
            @click="removeOption(index)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18" /><path d="M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Add option -->
      <button
        v-if="options.length < 10"
        class="mb-4 flex items-center gap-1 text-xs text-color-bg-ac hover:underline"
        @click="addOption"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Add option
      </button>

      <!-- Create button -->
      <button
        class="w-full rounded-lg py-2.5 text-sm font-medium text-white transition-colors"
        :class="canCreate() ? 'bg-color-bg-ac hover:bg-color-bg-ac/90' : 'bg-neutral-grad-2 cursor-not-allowed'"
        :disabled="!canCreate()"
        @click="handleCreate"
      >
        Create Poll
      </button>
    </div>
  </Teleport>
</template>
