<script setup lang="ts">
import { ref, computed } from "vue";
import type { MediaFile } from "../model/use-media-upload";

const { t } = useI18n();

interface Props {
  show: boolean;
  files: MediaFile[];
  activeIndex: number;
  caption: string;
  captionAbove: boolean;
  sending: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
  send: [];
  "update:activeIndex": [index: number];
  "update:caption": [value: string];
  "update:captionAbove": [value: boolean];
  removeFile: [index: number];
}>();

const showCaptionMenu = ref(false);

const activeFile = computed(() => props.files[props.activeIndex] ?? null);

const handleSend = () => {
  emit("send");
};

const toggleCaptionPosition = () => {
  emit("update:captionAbove", !props.captionAbove);
  showCaptionMenu.value = false;
};
</script>

<template>
  <Teleport to="body">
    <transition name="media-preview">
      <div v-if="props.show && files.length > 0" class="fixed inset-0 z-50 flex flex-col bg-black/95" style="padding-top: var(--safe-area-inset-top, 0px)">
        <!-- Top bar -->
        <div class="flex shrink-0 items-center justify-between px-4 py-3">
          <button
            class="flex h-10 w-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10"
            @click="emit('close')"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18" /><path d="M6 6l12 12" />
            </svg>
          </button>
          <span class="text-sm text-white/60">{{ props.activeIndex + 1 }} / {{ files.length }}</span>
          <div class="w-10" />
        </div>

        <!-- Main media area -->
        <div class="flex flex-1 items-center justify-center overflow-hidden px-4">
          <template v-if="activeFile">
            <img
              v-if="activeFile.type === 'image'"
              :src="activeFile.previewUrl"
              class="max-h-full max-w-full object-contain"
            />
            <video
              v-else
              :src="activeFile.previewUrl"
              controls
              class="max-h-full max-w-full"
            />
          </template>
        </div>

        <!-- Thumbnail strip (multiple files) -->
        <div v-if="files.length > 1" class="flex shrink-0 gap-2 overflow-x-auto px-4 py-2">
          <div
            v-for="(f, i) in files"
            :key="i"
            class="relative h-14 w-14 shrink-0"
          >
            <button
              type="button"
              class="h-full w-full overflow-hidden rounded-lg border-2 transition-all"
              :class="i === props.activeIndex ? 'border-white' : 'border-transparent opacity-60'"
              @click="emit('update:activeIndex', i)"
            >
              <img v-if="f.type === 'image'" :src="f.previewUrl" class="h-full w-full object-cover" />
              <div v-else class="flex h-full w-full items-center justify-center bg-white/10">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="text-white"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              </div>
            </button>
            <!-- Remove control (sibling of thumbnail button — avoids invalid nested <button>) -->
            <button
              type="button"
              class="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white"
              @click.stop="emit('removeFile', i)"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <path d="M18 6L6 18" /><path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Caption input + send -->
        <div class="shrink-0 border-t border-white/10 px-4 py-3" style="padding-bottom: calc(max(var(--keyboardheight, 0px), var(--safe-area-inset-bottom, 0px)) + 12px)">
          <div class="flex items-end gap-3">
            <input
              :value="props.caption"
              type="text"
              :placeholder="t('media.addCaption')"
              maxlength="1024"
              class="flex-1 rounded-xl bg-white/10 px-4 py-2.5 text-sm text-white outline-none placeholder:text-white/40"
              @input="emit('update:caption', ($event.target as HTMLInputElement).value)"
              @keydown.enter="handleSend"
            />
            <div class="relative">
              <button
                class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac text-white transition-all"
                :class="props.sending ? 'opacity-50' : 'hover:brightness-110'"
                :disabled="props.sending"
                @click="handleSend"
                @contextmenu.prevent="showCaptionMenu = !showCaptionMenu"
              >
                <div v-if="props.sending" class="h-5 w-5 shrink-0 contain-strict animate-spin rounded-full border-2 border-white border-t-transparent" />
                <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
              <!-- Caption position menu -->
              <div
                v-if="showCaptionMenu"
                class="absolute bottom-12 right-0 w-48 overflow-hidden rounded-lg bg-neutral-800 shadow-xl"
              >
                <button
                  class="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-white transition-colors hover:bg-white/10"
                  @click="toggleCaptionPosition"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
                  </svg>
                  {{ props.captionAbove ? "Caption below" : "Caption above" }}
                </button>
              </div>
            </div>
          </div>
          <div v-if="props.caption" class="mt-1 text-right text-xs text-white/40">
            {{ props.caption.length }} / 1024
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.media-preview-enter-active { transition: opacity 0.2s ease; }
.media-preview-leave-active { transition: opacity 0.15s ease; }
.media-preview-enter-from,
.media-preview-leave-to { opacity: 0; }
</style>
