<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { UserAvatar } from "@/entities/user";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { useCallService } from "@/features/video-calls/model/call-service";

interface Props {
  show: boolean;
  address: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
const chatStore = useChatStore();
const authStore = useAuthStore();
const callService = useCallService();

const userData = ref<{ name: string; about: string; site: string; image: string } | null>(null);
const copiedAddress = ref(false);

watch(
  () => props.address,
  async (addr) => {
    if (!addr) {
      userData.value = null;
      return;
    }
    await authStore.loadUsersInfo([addr]);
    userData.value = authStore.getBastyonUserData(addr) ?? null;
  },
  { immediate: true },
);

// Reset copied state when panel closes
watch(
  () => props.show,
  (v) => {
    if (!v) copiedAddress.value = false;
  },
);

const displayName = computed(() => {
  if (userData.value?.name) return userData.value.name;
  // Fall back to address if no name loaded
  return props.address;
});

const copyAddress = async () => {
  if (!props.address) return;
  await navigator.clipboard.writeText(props.address);
  copiedAddress.value = true;
  setTimeout(() => (copiedAddress.value = false), 2000);
};

const navigateToChat = () => {
  const hexAddr = hexEncode(props.address).toLowerCase();
  const existingRoom = chatStore.sortedRooms.find(
    (r) => !r.isGroup && r.members.includes(hexAddr),
  );
  if (existingRoom) {
    chatStore.setActiveRoom(existingRoom.id);
  }
  emit("close");
};

const startCall = (type: "voice" | "video") => {
  const hexAddr = hexEncode(props.address).toLowerCase();
  const existingRoom = chatStore.sortedRooms.find(
    (r) => !r.isGroup && r.members.includes(hexAddr),
  );
  if (existingRoom) {
    callService.startCall(existingRoom.id, type);
  }
  emit("close");
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
        v-if="props.show"
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
              <UserAvatar :address="props.address" size="xl" />
              <div class="text-center">
                <h2 class="text-lg font-semibold text-text-color">{{ displayName }}</h2>
              </div>
            </div>

            <!-- Action buttons row -->
            <div class="flex items-center justify-center gap-6 pb-4">
              <!-- Chat button -->
              <button class="flex flex-col items-center gap-1" @click="navigateToChat">
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac transition-colors hover:bg-color-bg-ac/20">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <span class="text-[11px] text-text-on-main-bg-color">{{ t("chatInfo.chat") }}</span>
              </button>

              <!-- Call button -->
              <button class="flex flex-col items-center gap-1" @click="startCall('voice')">
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac transition-colors hover:bg-color-bg-ac/20">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                  </svg>
                </div>
                <span class="text-[11px] text-text-on-main-bg-color">{{ t("chatInfo.call") }}</span>
              </button>

              <!-- More button (video call) -->
              <button class="flex flex-col items-center gap-1" @click="startCall('video')">
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac transition-colors hover:bg-color-bg-ac/20">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                  </svg>
                </div>
                <span class="text-[11px] text-text-on-main-bg-color">{{ t("chatInfo.videoCall") }}</span>
              </button>
            </div>

            <!-- Contact info section -->
            <div class="border-t border-neutral-grad-0 px-4 py-3">
              <!-- About -->
              <div v-if="userData?.about" class="mb-3">
                <div class="mb-1 text-xs text-text-on-main-bg-color">{{ t("chatInfo.about") }}</div>
                <div class="text-sm text-text-color">{{ userData.about }}</div>
              </div>
              <!-- Website -->
              <div v-if="userData?.site" class="mb-3">
                <div class="mb-1 text-xs text-text-on-main-bg-color">{{ t("chatInfo.website") }}</div>
                <a :href="userData.site" target="_blank" class="text-sm text-color-txt-ac hover:underline">{{ userData.site }}</a>
              </div>
              <!-- Bastyon Address -->
              <div v-if="props.address">
                <div class="mb-1 text-xs text-text-on-main-bg-color">{{ t("chatInfo.address") }}</div>
                <button class="group flex items-center gap-2 text-sm text-text-color" @click="copyAddress">
                  <span class="font-mono text-xs">{{ props.address }}</span>
                  <svg v-if="!copiedAddress" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-color-txt-gray transition-colors group-hover:text-text-on-main-bg-color">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span v-else class="text-xs text-color-good">{{ t("chatInfo.copied") }}</span>
                </button>
              </div>
              <!-- Profile link -->
              <div v-if="props.address" class="mt-3">
                <a
                  :href="`bastyon://user?address=${props.address}`"
                  class="inline-flex items-center gap-2 text-sm text-color-txt-ac hover:underline"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                  {{ t("chatInfo.viewProfile") }}
                </a>
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
