<script setup lang="ts">
import { ref, computed } from "vue";
import { useChatStore } from "@/entities/chat";
import { BottomSheet } from "@/shared/ui/bottom-sheet";
import { UserAvatar } from "@/entities/user";
import { useMessages } from "../model/use-messages";
import { useToast } from "@/shared/lib/use-toast";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { isUnresolvedName } from "@/entities/chat/lib/chat-helpers";

interface Props {
  show: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

const chatStore = useChatStore();
const { forwardMessage } = useMessages();
const { toast } = useToast();
const { t } = useI18n();
const { resolve: resolveRoomName } = useResolvedRoomName();

const search = ref("");
const selectedRoomIds = ref<Set<string>>(new Set());
const withSenderInfo = ref(true);
const sending = ref(false);

const filteredRooms = computed(() => {
  const q = search.value.toLowerCase();
  if (!q) return chatStore.sortedRooms;
  return chatStore.sortedRooms.filter(r => {
    const name = resolveRoomName(r);
    return name.toLowerCase().includes(q);
  });
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
    const selectedMsgIds = chatStore.selectedMessageIds;
    const msgs = chatStore.activeMessages.filter(m => selectedMsgIds.has(m.id));

    for (const targetRoomId of selectedRoomIds.value) {
      for (const msg of msgs) {
        await forwardMessage(msg, targetRoomId, withSenderInfo.value);
      }
    }

    const msgCount = msgs.length;
    const roomCount = selectedRoomIds.value.size;
    toast(t("forward.success", { msgCount, roomCount }));
    chatStore.exitSelectionMode();
  } catch (e) {
    console.error("Forward error:", e);
    toast(t("forward.failed"));
  } finally {
    sending.value = false;
    selectedRoomIds.value = new Set();
    search.value = "";
    emit("close");
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
      <span class="text-base font-semibold text-text-color">{{ t("forward.title") }}</span>
      <span v-if="selectedRoomIds.size > 0" class="text-sm text-color-bg-ac">
        {{ t("forward.selected", { count: selectedRoomIds.size }) }}
      </span>
    </div>

    <input
      v-model="search"
      type="text"
      :placeholder="t('forward.searchPlaceholder')"
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

        <!-- Avatar -->
        <UserAvatar
          v-if="room.avatar?.startsWith('__pocketnet__:')"
          :address="room.avatar.replace('__pocketnet__:', '')"
          size="sm"
        />
        <div
          v-else
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-xs font-medium text-white"
        >
          {{ (resolveRoomName(room) || '?')[0].toUpperCase() }}
        </div>

        <div class="min-w-0 flex-1 text-left">
          <span v-if="isUnresolvedName(resolveRoomName(room))" class="inline-block h-3.5 w-24 animate-pulse rounded bg-neutral-grad-2" />
          <span v-else class="truncate text-sm text-text-color">{{ resolveRoomName(room) }}</span>
        </div>
      </button>

      <div v-if="filteredRooms.length === 0" class="p-4 text-center text-sm text-text-on-main-bg-color">
        {{ t("forward.noChats") }}
      </div>
    </div>

    <label class="mt-3 flex items-center gap-2 text-sm text-text-on-main-bg-color">
      <input v-model="withSenderInfo" type="checkbox" class="accent-color-bg-ac" />
      {{ t("forward.includeSender") }}
    </label>

    <button
      class="mt-4 w-full rounded-lg bg-color-bg-ac py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac-1 disabled:opacity-50"
      :disabled="selectedRoomIds.size === 0 || sending"
      @click="handleSend"
    >
      {{ sending ? t("forward.sending") : t("forward.button", { count: selectedRoomIds.size }) }}
    </button>
  </BottomSheet>
</template>
