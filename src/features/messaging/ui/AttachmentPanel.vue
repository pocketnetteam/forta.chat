<script setup lang="ts">
import { computed } from "vue";
import { useMobile } from "@/shared/lib/composables/use-media-query";
import { BottomSheet } from "@/shared/ui/bottom-sheet";

const isMobile = useMobile();

interface Props {
  show: boolean;
  x: number;
  y: number;
  /** Show "Send PKOIN" option (1:1 chats with wallet available) */
  showDonate?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: []; selectPhoto: []; selectFile: []; selectPoll: []; selectDonate: [] }>();

const itemCount = computed(() => 3 + (props.showDonate ? 1 : 0));

const panelStyle = computed(() => {
  const menuW = 200;
  const menuH = itemCount.value * 48 + 8;
  const pad = 8;
  let left = props.x - menuW / 2;
  let top = props.y - menuH - pad;
  // Clamp to viewport
  left = Math.max(pad, Math.min(left, window.innerWidth - menuW - pad));
  if (top < pad) top = props.y + pad;
  return { left: `${left}px`, top: `${top}px` };
});

const selectPhoto = () => { emit("selectPhoto"); emit("close"); };
const selectFile = () => { emit("selectFile"); emit("close"); };
const selectPoll = () => { emit("selectPoll"); emit("close"); };
const selectDonate = () => { emit("selectDonate"); emit("close"); };
</script>

<template>
  <!-- Mobile: BottomSheet -->
  <BottomSheet v-if="isMobile" :show="props.show" aria-label="Attachments" @close="emit('close')">
    <button
      class="flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-base text-text-color transition-colors active:bg-neutral-grad-0"
      @click="selectPhoto"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="shrink-0 text-color-bg-ac">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
      Photo or Video
    </button>
    <button
      class="flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-base text-text-color transition-colors active:bg-neutral-grad-0"
      @click="selectFile"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="shrink-0 text-color-bg-ac">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      File
    </button>
    <button
      class="flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-base text-text-color transition-colors active:bg-neutral-grad-0"
      @click="selectPoll"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="shrink-0 text-color-bg-ac">
        <rect x="3" y="4" width="7" height="4" rx="1" />
        <rect x="3" y="10" width="13" height="4" rx="1" />
        <rect x="3" y="16" width="10" height="4" rx="1" />
      </svg>
      Poll
    </button>
    <button
      v-if="props.showDonate"
      class="flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-base text-text-color transition-colors active:bg-neutral-grad-0"
      @click="selectDonate"
    >
      <svg width="22" height="22" viewBox="0 0 18 18" fill="currentColor" class="shrink-0 text-color-bg-ac">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M17.2584 1.97869L15.182 0L12.7245 2.57886C11.5308 1.85218 10.1288 1.43362 8.62907 1.43362C7.32722 1.43362 6.09904 1.74902 5.01676 2.30756L2.81787 6.45386e-05L0.741455 1.97875L2.73903 4.07498C1.49651 5.46899 0.741455 7.30694 0.741455 9.32124C0.741455 11.1753 1.38114 12.8799 2.45184 14.2264L0.741455 16.0213L2.81787 18L4.61598 16.1131C5.79166 16.8092 7.1637 17.2088 8.62907 17.2088C10.2903 17.2088 11.8317 16.6953 13.1029 15.8182L15.182 18L17.2584 16.0213L15.1306 13.7884C16.0049 12.5184 16.5167 10.9796 16.5167 9.32124C16.5167 7.50123 15.9003 5.8252 14.8648 4.49052L17.2584 1.97869ZM3.5551 9.32124C3.5551 12.1235 5.82679 14.3952 8.62907 14.3952C11.4313 14.3952 13.703 12.1235 13.703 9.32124C13.703 6.51896 11.4313 4.24727 8.62907 4.24727C5.82679 4.24727 3.5551 6.51896 3.5551 9.32124Z" />
      </svg>
      PKOIN
    </button>
  </BottomSheet>

  <!-- Desktop: positioned dropdown -->
  <Teleport v-else to="body">
    <transition name="attach-popup">
      <div v-if="props.show" class="fixed inset-0 z-50" @click.self="emit('close')">
        <div
          class="fixed z-50 w-[200px] overflow-hidden rounded-xl border border-neutral-grad-0 bg-background-total-theme shadow-xl"
          :style="panelStyle"
        >
          <button
            class="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-text-color transition-colors hover:bg-neutral-grad-0"
            @click="selectPhoto"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="shrink-0 text-color-bg-ac">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            Photo or Video
          </button>
          <button
            class="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-text-color transition-colors hover:bg-neutral-grad-0"
            @click="selectFile"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="shrink-0 text-color-bg-ac">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            File
          </button>
          <button
            class="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-text-color transition-colors hover:bg-neutral-grad-0"
            @click="selectPoll"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="shrink-0 text-color-bg-ac">
              <rect x="3" y="4" width="7" height="4" rx="1" />
              <rect x="3" y="10" width="13" height="4" rx="1" />
              <rect x="3" y="16" width="10" height="4" rx="1" />
            </svg>
            Poll
          </button>
          <button
            v-if="props.showDonate"
            class="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-text-color transition-colors hover:bg-neutral-grad-0"
            @click="selectDonate"
          >
            <svg width="20" height="20" viewBox="0 0 18 18" fill="currentColor" class="shrink-0 text-color-bg-ac">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M17.2584 1.97869L15.182 0L12.7245 2.57886C11.5308 1.85218 10.1288 1.43362 8.62907 1.43362C7.32722 1.43362 6.09904 1.74902 5.01676 2.30756L2.81787 6.45386e-05L0.741455 1.97875L2.73903 4.07498C1.49651 5.46899 0.741455 7.30694 0.741455 9.32124C0.741455 11.1753 1.38114 12.8799 2.45184 14.2264L0.741455 16.0213L2.81787 18L4.61598 16.1131C5.79166 16.8092 7.1637 17.2088 8.62907 17.2088C10.2903 17.2088 11.8317 16.6953 13.1029 15.8182L15.182 18L17.2584 16.0213L15.1306 13.7884C16.0049 12.5184 16.5167 10.9796 16.5167 9.32124C16.5167 7.50123 15.9003 5.8252 14.8648 4.49052L17.2584 1.97869ZM3.5551 9.32124C3.5551 12.1235 5.82679 14.3952 8.62907 14.3952C11.4313 14.3952 13.703 12.1235 13.703 9.32124C13.703 6.51896 11.4313 4.24727 8.62907 4.24727C5.82679 4.24727 3.5551 6.51896 3.5551 9.32124Z" />
            </svg>
            PKOIN
          </button>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.attach-popup-enter-active {
  transition: opacity 0.18s cubic-bezier(0.34, 1.56, 0.64, 1),
    transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.attach-popup-leave-active {
  transition: opacity 0.12s ease-in, transform 0.12s ease-in;
}
.attach-popup-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.85);
}
.attach-popup-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.85);
}
</style>
