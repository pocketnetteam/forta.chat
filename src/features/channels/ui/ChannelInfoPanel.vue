<script setup lang="ts">
import type { Channel } from "@/entities/channel/model/types";
import { useChatStore } from "@/entities/chat";
import { getMatrixClientService } from "@/entities/matrix";
import { hexEncode } from "@/shared/lib/matrix/functions";
import Avatar from "@/shared/ui/avatar/Avatar.vue";

interface Props {
  show: boolean;
  channel: Channel | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: []; selectRoom: [] }>();
const { t } = useI18n();
const chatStore = useChatStore();

const copiedAddress = ref(false);
const creatingChat = ref(false);

watch(
  () => props.show,
  (v) => { if (!v) copiedAddress.value = false; },
);

const navigateToChat = async () => {
  if (!props.channel?.address || creatingChat.value) return;
  const addr = props.channel.address;
  const hexAddr = hexEncode(addr).toLowerCase();
  const existingRoom = chatStore.sortedRooms.find(
    (r) => !r.isGroup && r.members.includes(hexAddr),
  );
  if (existingRoom) {
    chatStore.setActiveRoom(existingRoom.id);
    emit("close");
    emit("selectRoom");
    return;
  }
  // Create new DM
  creatingChat.value = true;
  try {
    const matrixService = getMatrixClientService();
    if (!matrixService) return;
    const result = await matrixService.createRoom({
      is_direct: true,
      invite: [hexAddr],
      visibility: "private",
      preset: "trusted_private_chat",
    });
    if (result?.room_id) {
      chatStore.setActiveRoom(result.room_id);
      emit("close");
      emit("selectRoom");
    }
  } finally {
    creatingChat.value = false;
  }
};

const copyAddress = async () => {
  if (!props.channel?.address) return;
  await navigator.clipboard.writeText(props.channel.address);
  copiedAddress.value = true;
  setTimeout(() => (copiedAddress.value = false), 2000);
};
</script>

<template>
  <Teleport to="body">
    <transition name="panel-fade">
      <div
        v-if="props.show"
        class="fixed inset-0 z-40 bg-black/40"
        @click="emit('close')"
      />
    </transition>
    <transition name="panel-slide">
      <div
        v-if="props.show && props.channel"
        class="safe-y fixed right-0 top-0 z-50 h-full w-full bg-background-total-theme shadow-xl sm:w-[360px] sm:max-w-full"
        @click.stop
      >
        <div class="flex h-full flex-col">
          <!-- Header -->
          <div class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-grad-0 px-4">
            <button
              class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
              @click="emit('close')"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6L6 18" /><path d="M6 6l12 12" />
              </svg>
            </button>
            <span class="text-base font-semibold text-text-color">{{ t("chatInfo.information") }}</span>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-y-auto">
            <!-- Avatar + Name -->
            <div class="flex flex-col items-center gap-3 p-6">
              <Avatar :src="props.channel.avatar" :name="props.channel.name" size="xl" />
              <div class="text-center">
                <h2 class="text-lg font-semibold text-text-color">{{ props.channel.name }}</h2>
                <div class="mt-1 flex items-center justify-center gap-1 text-xs text-text-on-main-bg-color">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1zm16 2a6 6 0 0 0-3-5.2v10.4A6 6 0 0 0 19 12z" />
                  </svg>
                  {{ t("tabs.channels") }}
                </div>
              </div>
            </div>

            <!-- Action buttons -->
            <div class="flex items-center justify-center gap-6 pb-4">
              <!-- Chat / Write message -->
              <button class="flex flex-col items-center gap-1" :disabled="creatingChat" @click="navigateToChat">
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac transition-colors hover:bg-color-bg-ac/20">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <span class="text-[11px] text-text-on-main-bg-color">{{ t("chatInfo.chat") }}</span>
              </button>

              <!-- Open in Bastyon -->
              <a
                :href="`bastyon://channel?address=${props.channel.address}`"
                class="flex flex-col items-center gap-1"
              >
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac transition-colors hover:bg-color-bg-ac/20">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </div>
                <span class="text-[11px] text-text-on-main-bg-color">{{ t("channels.openInApp") }}</span>
              </a>
            </div>

            <!-- Channel info section -->
            <div class="border-t border-neutral-grad-0 px-4 py-3">
              <!-- Address -->
              <div>
                <div class="mb-1 text-xs text-text-on-main-bg-color">{{ t("channels.address") }}</div>
                <button class="group flex items-center gap-2 text-sm text-text-color" @click="copyAddress">
                  <span class="font-mono text-xs break-all">{{ props.channel.address }}</span>
                  <svg v-if="!copiedAddress" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-color-txt-gray transition-colors group-hover:text-text-on-main-bg-color">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span v-else class="shrink-0 text-xs text-color-good">{{ t("chatInfo.copied") }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.panel-fade-enter-active {
  transition: opacity 0.25s ease-out;
}
.panel-fade-leave-active {
  transition: opacity 0.2s ease-in;
}
.panel-fade-enter-from,
.panel-fade-leave-to {
  opacity: 0;
}
.panel-slide-enter-active {
  transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
}
.panel-slide-leave-active {
  transition: transform 0.2s ease-in;
}
.panel-slide-enter-from,
.panel-slide-leave-to {
  transform: translateX(100%);
}
</style>
