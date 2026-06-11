<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import { useChatStore, type ChatRoom } from "@/entities/chat";
import { UserAvatar } from "@/entities/user";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { isUnresolvedName } from "@/entities/chat/lib/chat-helpers";
import { useMobile } from "@/shared/lib/composables/use-media-query";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
type FilterValue = "all" | "personal" | "groups";

/** Fixed row height for RecycleScroller: 40px md avatar + 2×10px padding. */
const ROW_HEIGHT = 60;

interface Props {
  show: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

const chatStore = useChatStore();
const { t } = useI18n();
const { resolve: resolveRoomName } = useResolvedRoomName();
const isMobile = useMobile();

const isBulkMode = computed(() => chatStore.forwardingMessages.length > 0);

const search = ref("");
const activeFilter = ref<FilterValue>("all");
const searchInputRef = ref<HTMLInputElement>();

// Android back handler
useAndroidBackHandler("forward-picker", 95, () => {
  if (!props.show) return false;
  handleClose();
  return true;
});

// WEE-100: the room list is heavy (member counts via Matrix SDK, avatars,
// name resolution × N rooms) — rendering it synchronously on open left a
// visible gap between the tap and the modal. Defer it by two frames so the
// shell (header/search/tabs/spinner) paints first.
const listReady = ref(false);
const memberCountCache = new Map<string, number>();
// Generation counter: a stale rAF chain from a previous open must not
// short-circuit the defer (or fire after close) on rapid close→reopen.
let openGeneration = 0;

// Focus search on open
watch(() => props.show, (v) => {
  if (v) {
    search.value = "";
    activeFilter.value = "all";
    listReady.value = false;
    memberCountCache.clear();
    const gen = ++openGeneration;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (props.show && gen === openGeneration) listReady.value = true;
    }));
    nextTick(() => searchInputRef.value?.focus());
  }
}, { immediate: true });

// Escape to close
const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") { e.stopPropagation(); handleClose(); }
};
watch(() => props.show, (v) => {
  if (v) document.addEventListener("keydown", onKeydown);
  else document.removeEventListener("keydown", onKeydown);
});

const localizedTabs = computed(() => [
  { value: "all" as const, label: t("tabs.all") },
  { value: "personal" as const, label: t("tabs.personal") },
  { value: "groups" as const, label: t("tabs.groups") },
]);

const filteredRooms = computed(() => {
  let rooms = chatStore.sortedRooms;

  // Apply folder filter
  if (activeFilter.value === "personal") rooms = rooms.filter(r => !r.isGroup && r.membership !== "invite");
  else if (activeFilter.value === "groups") rooms = rooms.filter(r => r.isGroup && r.membership !== "invite");

  // Apply search
  const q = search.value.toLowerCase();
  if (q) {
    rooms = rooms.filter(r => {
      const name = resolveRoomName(r);
      return name.toLowerCase().includes(q);
    });
  }

  return rooms;
});

/** Pre-resolved rows for the virtual list — one name resolve per room
 *  instead of 3-4 calls scattered across the row template. */
interface RoomListItem {
  id: string;
  room: ChatRoom;
  name: string;
}
const listItems = computed<RoomListItem[]>(() =>
  filteredRooms.value.map(room => ({ id: room.id, room, name: resolveRoomName(room) })),
);

const getRoomSubtitle = (room: ChatRoom): string => {
  if (!room.isGroup) return "";
  // getRoomMemberCount goes through the Matrix SDK — cache per open so
  // scrolling back / re-filtering doesn't repeat the lookup.
  let count = memberCountCache.get(room.id);
  if (count === undefined) {
    count = chatStore.getRoomMemberCount(room.id);
    memberCountCache.set(room.id, count);
  }
  if (count > 0) return t("forward.members", { count });
  return t("tabs.groups");
};

const selectRoom = async (roomId: string) => {
  // ── Bulk branch — lands the user in the target room with a preview bar
  // so they can optionally type a caption before shipping the batch.
  // Mirrors the singular draft-and-switch UX (Telegram/Element style). ──
  if (isBulkMode.value) {
    chatStore.saveBulkForwardDraft(roomId);
    chatStore.exitSelectionMode();
    chatStore.setActiveRoom(roomId);
    search.value = "";
    emit("close");
    return;
  }

  // Pre-save forward draft to TARGET room so it survives the room-switch watcher
  chatStore.saveForwardDraft(roomId);
  chatStore.setActiveRoom(roomId);
  search.value = "";
  emit("close");
};

const handleClose = () => {
  chatStore.cancelForward();
  search.value = "";
  emit("close");
};
</script>

<template>
  <Teleport to="body">
    <transition name="fp-fade">
      <div
        v-if="props.show"
        data-testid="forward-picker-root"
        class="fixed inset-0 z-[60] flex justify-center"
        :class="isMobile ? 'items-end' : 'items-center bg-black/40'"
        @click.self="handleClose"
      >
        <transition :name="isMobile ? 'fp-slide' : 'fp-scale'" appear>
          <div
            v-if="props.show"
            class="flex flex-col bg-background-total-theme"
            :class="isMobile
              ? 'h-full w-full safe-y'
              : 'my-auto max-h-[75vh] w-full max-w-md rounded-xl shadow-xl'"
          >
            <!-- Header -->
            <div class="flex shrink-0 items-center justify-between px-4 py-3">
              <button class="flex h-8 w-8 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0" @click="handleClose">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
              </button>
              <span class="text-base font-semibold text-text-color">{{ t("forward.title") }}</span>
              <div class="w-8" />
            </div>

            <!-- Search -->
            <div class="shrink-0 px-4 pb-2">
              <div class="flex items-center gap-2 rounded-lg bg-chat-input-bg px-3 py-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-neutral-grad-2">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  ref="searchInputRef"
                  v-model="search"
                  type="text"
                  :placeholder="t('forward.searchPlaceholder')"
                  class="w-full bg-transparent text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
                />
              </div>
            </div>

            <!-- Inline folder tabs (no channels, no invites) -->
            <div class="shrink-0 flex overflow-x-auto border-b border-neutral-grad-0">
              <button
                v-for="tab in localizedTabs"
                :key="tab.value"
                class="relative shrink-0 px-4 py-2.5 text-center text-[13px] font-medium whitespace-nowrap transition-colors"
                :class="activeFilter === tab.value ? 'text-color-bg-ac' : 'text-text-on-main-bg-color hover:text-text-color'"
                @click="activeFilter = tab.value"
              >
                {{ tab.label }}
                <div
                  v-if="activeFilter === tab.value"
                  class="absolute inset-x-1/4 bottom-0 h-0.5 rounded-full bg-color-bg-ac"
                />
              </button>
            </div>

            <!-- Room list: spinner while the deferred list mounts, then a
                 virtualized scroller — only visible rows render. The scroller
                 itself is the flex item (mirrors the pre-virtualization
                 `min-h-0 flex-1 overflow-y-auto` wrapper): a percentage height
                 inside the auto-height desktop modal resolves to the full
                 content height and overflows the max-h cap. -->
            <div
              v-if="!listReady"
              data-testid="forward-list-loading"
              class="flex h-24 shrink-0 items-center justify-center"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="animate-spin text-neutral-grad-2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            </div>

            <RecycleScroller
              v-else-if="listItems.length > 0"
              data-testid="forward-room-list"
              :items="listItems"
              :item-size="ROW_HEIGHT"
              key-field="id"
              class="min-h-0 flex-1"
              :class="isMobile ? 'pb-safe' : ''"
            >
              <template #default="{ item }">
                <button
                  class="flex w-full items-center gap-3 px-4 transition-colors hover:bg-neutral-grad-0 active:bg-neutral-grad-0"
                  :style="{ height: `${ROW_HEIGHT}px` }"
                  @click="selectRoom(item.room.id)"
                >
                  <div class="relative shrink-0">
                    <UserAvatar
                      v-if="item.room.avatar?.startsWith('__pocketnet__:')"
                      :address="item.room.avatar.replace('__pocketnet__:', '')"
                      size="md"
                    />
                    <Avatar v-else :src="item.room.avatar" :name="item.name || ''" size="md" />
                    <!-- Group badge -->
                    <div
                      v-if="item.room.isGroup"
                      class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background-total-theme"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-text-on-main-bg-color">
                        <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
                      </svg>
                    </div>
                  </div>

                  <div class="min-w-0 flex-1 text-left">
                    <div v-if="isUnresolvedName(item.name)" class="inline-block h-3.5 w-24 animate-pulse rounded bg-neutral-grad-2" />
                    <template v-else>
                      <div class="truncate text-[15px] font-medium text-text-color">{{ item.name }}</div>
                      <div v-if="getRoomSubtitle(item.room)" class="truncate text-xs text-text-on-main-bg-color">{{ getRoomSubtitle(item.room) }}</div>
                    </template>
                  </div>
                </button>
              </template>
            </RecycleScroller>

            <div v-else class="p-8 text-center text-sm text-text-on-main-bg-color">
              {{ t("forward.noChats") }}
            </div>
          </div>
        </transition>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.fp-fade-enter-active { transition: opacity 0.25s ease-out; }
.fp-fade-leave-active { transition: opacity 0.2s ease-in; }
.fp-fade-enter-from, .fp-fade-leave-to { opacity: 0; }

.fp-slide-enter-active { transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1); }
.fp-slide-leave-active { transition: transform 0.2s ease-in; }
.fp-slide-enter-from, .fp-slide-leave-to { transform: translateY(100%); }

.fp-scale-enter-active { transition: transform 0.2s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.2s ease-out; }
.fp-scale-leave-active { transition: transform 0.15s ease-in, opacity 0.15s ease-in; }
.fp-scale-enter-from, .fp-scale-leave-to { transform: scale(0.95); opacity: 0; }
</style>
