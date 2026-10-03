<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { requestJoinRoom } from "@/shared/lib/join-room-request";

interface Props {
  roomId: string;
  isOwn: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();
const chatStore = useChatStore();

// Already a member: name/avatar come from the local room list. An unknown
// room is not peeked here — a matrix-js-sdk peek is one-at-a-time and keeps
// polling /events, so several cards would cancel each other. The join modal
// (opened by requestJoinRoom) peeks once, on demand.
const knownRoom = computed(() => chatStore.rooms.find((r) => r.id === props.roomId) ?? null);
const avatarError = ref(false);

const displayName = computed(() => knownRoom.value?.name || t("roomLink.unknown"));
const avatarUrl = computed(() => (avatarError.value ? "" : knownRoom.value?.avatar || ""));
const members = computed(() => knownRoom.value?.members.length || 0);

function onOpen() {
  requestJoinRoom(props.roomId);
}
</script>

<template>
  <div
    class="my-1.5 w-[20rem] max-w-full cursor-pointer overflow-hidden rounded-2xl border sm:w-[28rem]"
    :class="isOwn ? 'border-white/10 bg-white/[0.08]' : 'border-neutral-grad-1/50 bg-background-total-theme'"
    @click.stop="onOpen"
  >
    <div class="flex items-center gap-3 p-3 sm:p-4">
      <img
        v-if="avatarUrl"
        :src="avatarUrl"
        alt=""
        class="h-14 w-14 shrink-0 rounded-full object-cover"
        loading="lazy"
        @error="avatarError = true"
      />
      <div
        v-else
        class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
        :class="isOwn ? 'bg-white/20 text-white' : 'bg-color-bg-ac/20 text-color-bg-ac'"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
      </div>

      <div class="flex min-w-0 flex-col gap-0.5">
        <span
          class="text-[10px] font-semibold uppercase tracking-wider"
          :class="isOwn ? 'text-white/60' : 'text-color-txt-ac'"
        >{{ t("roomLink.label") }}</span>
        <span
          class="truncate text-sm font-semibold leading-snug sm:text-base"
          :class="isOwn ? 'text-white' : 'text-text-color'"
        >{{ displayName }}</span>
        <span
          v-if="members"
          class="text-[11px] sm:text-xs"
          :class="isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'"
        >{{ t("roomLink.members", { count: members }) }}</span>
      </div>
    </div>

    <div class="p-3 sm:p-4">
      <button
        class="w-full rounded-xl py-2 text-xs font-semibold text-white transition-colors sm:py-2.5 sm:text-sm"
        :class="isOwn ? 'bg-white/20 hover:bg-white/30' : 'bg-color-bg-ac hover:bg-color-bg-ac-1'"
        @click.stop="onOpen"
      >
        {{ knownRoom ? t("roomLink.open") : t("joinRoom.join") }}
      </button>
    </div>
  </div>
</template>
