<script setup lang="ts">
import { ref, watch } from "vue";
import { useChatStore } from "@/entities/chat";

interface PreviewData {
  name?: string;
  topic?: string;
  avatar?: string | null;
  memberCount?: number;
  isEncrypted?: boolean;
}

interface Props {
  show: boolean;
  roomId: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  join: [];
  cancel: [];
}>();

const { t } = useI18n();
const chatStore = useChatStore();

const loading = ref(false);
const preview = ref<PreviewData | null>(null);
const peekFailed = ref(false);

watch(
  () => [props.show, props.roomId],
  async ([visible, rid]) => {
    if (!visible || !rid) {
      preview.value = null;
      peekFailed.value = false;
      return;
    }
    loading.value = true;
    peekFailed.value = false;
    try {
      const data = await chatStore.peekRoom(rid as string);
      if (!data) {
        // Peek denied (private room) or SDK lacks peekInRoom — still offer
        // Join with a "try anyway" hint.
        peekFailed.value = true;
        preview.value = null;
      } else {
        preview.value = data;
      }
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);
</script>

<template>
  <Teleport to="body">
    <transition name="fade">
      <div
        v-if="props.show"
        class="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
        @click="emit('cancel')"
      >
        <div
          class="w-full max-w-sm rounded-2xl bg-background-total-theme p-6 shadow-xl"
          @click.stop
        >
          <!-- Loading -->
          <div v-if="loading" class="flex flex-col items-center gap-3 py-6">
            <div class="h-8 w-8 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
            <p class="text-sm text-text-on-main-bg-color">
              {{ t("joinRoom.loading") }}
            </p>
          </div>

          <!-- Private-room fallback -->
          <template v-else-if="peekFailed">
            <h3 class="mb-2 text-lg font-semibold text-text-color">
              {{ t("joinRoom.privateTitle") }}
            </h3>
            <p class="mb-6 text-sm text-text-on-main-bg-color">
              {{ t("joinRoom.privateHint") }}
            </p>
            <div class="flex gap-2">
              <button
                class="flex-1 rounded-lg bg-neutral-grad-0 px-4 py-2.5 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
                @click="emit('cancel')"
              >
                {{ t("info.cancel") }}
              </button>
              <button
                class="flex-1 rounded-lg bg-color-bg-ac px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac/90"
                @click="emit('join')"
              >
                {{ t("joinRoom.tryAnyway") }}
              </button>
            </div>
          </template>

          <!-- Preview with data -->
          <template v-else-if="preview">
            <div class="mb-4 flex flex-col items-center text-center">
              <Avatar :src="preview.avatar ?? undefined" :name="preview.name" size="xl" />
              <h3 class="mt-3 text-lg font-semibold text-text-color">
                {{ preview.name || t("joinRoom.unnamed") }}
              </h3>
              <p v-if="preview.topic" class="mt-1 text-sm text-text-on-main-bg-color">
                {{ preview.topic }}
              </p>
              <p class="mt-2 text-xs text-text-on-main-bg-color">
                {{ t("info.members", { count: preview.memberCount ?? 0 }) }}
              </p>
              <span
                v-if="preview.isEncrypted"
                class="mt-2 inline-flex items-center gap-1 rounded-full bg-color-good/15 px-2 py-0.5 text-[11px] text-color-good"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                {{ t("joinRoom.encrypted") }}
              </span>
            </div>
            <div class="flex gap-2">
              <button
                class="flex-1 rounded-lg bg-neutral-grad-0 px-4 py-2.5 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
                @click="emit('cancel')"
              >
                {{ t("info.cancel") }}
              </button>
              <button
                class="flex-1 rounded-lg bg-color-bg-ac px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac/90"
                @click="emit('join')"
              >
                {{ t("joinRoom.join") }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease-out;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
