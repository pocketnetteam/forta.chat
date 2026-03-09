<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { getMatrixClientService } from "@/entities/matrix";
import { BottomSheet } from "@/shared/ui/bottom-sheet";
import { UserAvatar } from "@/entities/user";

interface Props {
  show: boolean;
  postLink: string;
  postTitle?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const chatStore = useChatStore();
const authStore = useAuthStore();

const search = ref("");
const selectedRoomIds = ref<Set<string>>(new Set());
const sending = ref(false);

const filteredRooms = computed(() => {
  const q = search.value.toLowerCase();
  if (!q) return chatStore.sortedRooms;
  return chatStore.sortedRooms.filter(r => r.name.toLowerCase().includes(q));
});

const toggleRoom = (roomId: string) => {
  const s = new Set(selectedRoomIds.value);
  if (s.has(roomId)) s.delete(roomId);
  else s.add(roomId);
  selectedRoomIds.value = s;
};

const handleSend = async () => {
  if (selectedRoomIds.value.size === 0) return;
  sending.value = true;

  try {
    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) return;

    const text = props.postTitle
      ? `${props.postTitle}\n${props.postLink}`
      : props.postLink;

    for (const targetRoomId of selectedRoomIds.value) {
      const roomCrypto = (authStore as any).pcrypto?.rooms?.[targetRoomId];
      if (roomCrypto?.canBeEncrypt?.()) {
        const encrypted = await roomCrypto.encryptEvent(text);
        await matrixService.sendEncryptedText(targetRoomId, encrypted);
      } else {
        await matrixService.sendText(targetRoomId, text);
      }
    }

    emit("close");
  } catch (e) {
    console.error("[SharePostPicker] send error:", e);
  } finally {
    sending.value = false;
    selectedRoomIds.value = new Set();
    search.value = "";
  }
};

const handleClose = () => {
  selectedRoomIds.value = new Set();
  search.value = "";
  emit("close");
};
</script>

<template>
  <BottomSheet :show="props.show" @close="handleClose">
    <div class="mb-3 flex items-center justify-between">
      <span class="text-base font-semibold text-text-color">{{ t("postPlayer.share") }}</span>
      <span v-if="selectedRoomIds.size > 0" class="text-sm text-color-bg-ac">
        {{ selectedRoomIds.size }}
      </span>
    </div>

    <input
      v-model="search"
      type="text"
      placeholder="Search chats..."
      class="mb-3 w-full rounded-lg bg-chat-input-bg px-3 py-2 text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
    />

    <div class="max-h-[40vh] overflow-y-auto">
      <button
        v-for="room in filteredRooms"
        :key="room.id"
        class="flex w-full items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-neutral-grad-0"
        @click="toggleRoom(room.id)"
      >
        <div
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors"
          :class="selectedRoomIds.has(room.id) ? 'border-color-bg-ac bg-color-bg-ac' : 'border-neutral-grad-2'"
        >
          <svg v-if="selectedRoomIds.has(room.id)" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <UserAvatar
          v-if="room.avatar?.startsWith('__pocketnet__:')"
          :address="room.avatar.replace('__pocketnet__:', '')"
          size="sm"
        />
        <div
          v-else
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-xs font-medium text-white"
        >
          {{ (room.name || '?')[0].toUpperCase() }}
        </div>

        <div class="min-w-0 flex-1 text-left">
          <span class="truncate text-sm text-text-color">{{ room.name }}</span>
        </div>
      </button>

      <div v-if="filteredRooms.length === 0" class="p-4 text-center text-sm text-text-on-main-bg-color">
        No chats found
      </div>
    </div>

    <button
      class="mt-4 w-full rounded-lg bg-color-bg-ac py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac-1 disabled:opacity-50"
      :disabled="selectedRoomIds.size === 0 || sending"
      @click="handleSend"
    >
      {{ sending ? "..." : `${t("postPlayer.send")} (${selectedRoomIds.size})` }}
    </button>
  </BottomSheet>
</template>
