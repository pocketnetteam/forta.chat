<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { useUserStore } from "@/entities/user/model";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { isUnresolvedName } from "@/entities/chat/lib/chat-helpers";
import { RecycleScroller } from "vue-virtual-scroller";

const chatStore = useChatStore();
const userStore = useUserStore();
const emit = defineEmits<{ selectRoom: [] }>();
const { resolve: resolveRoomName } = useResolvedRoomName();

const { t } = useI18n();
const searchQuery = ref("");
const searchOpen = ref(false);

interface ContactItem {
  id: string;
  _key: string;
  name: string;
  address: string | undefined;
  image: string | undefined;
  deleted: boolean;
}

const contacts = computed<ContactItem[]>(() => {
  const list = chatStore.sortedRooms
    .filter((r) => !r.isGroup && r.membership !== "invite")
    .map((room) => {
      const address = room.avatar?.startsWith("__pocketnet__:")
        ? room.avatar.replace("__pocketnet__:", "")
        : undefined;
      const user = address ? userStore.getUser(address) : undefined;
      const resolved = resolveRoomName(room);
      const deleted = user?.deleted === true;
      return {
        id: room.id,
        _key: room.id,
        name: deleted ? t("profile.deletedAccount") : (user?.name || (isUnresolvedName(resolved) ? "" : resolved)),
        address,
        image: user?.image,
        deleted,
      };
    });

  if (!searchQuery.value.trim()) return list;

  const q = searchQuery.value.trim().toLowerCase();
  return list.filter(
    (c) =>
      c.name?.toLowerCase().includes(q) ||
      c.address?.toLowerCase().includes(q),
  );
});

// --- Viewport-based lazy profile loading ---
const ITEM_HEIGHT = 56;
const scrollerRef = ref<InstanceType<typeof RecycleScroller>>();

/** Load profiles only for contacts currently visible in the viewport.
 *  Uses the same mechanism as ContactList.vue: loadProfilesForRoomIds resolves
 *  member addresses from Matrix SDK data or hex-encoded room members, then
 *  loadMembersForRooms fetches members from server for rooms with unresolved names. */
const loadVisibleContacts = () => {
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (!el) return;
  const { scrollTop, clientHeight } = el;
  if (clientHeight === 0) return;

  const firstIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 2);
  const lastIdx = Math.min(
    contacts.value.length - 1,
    Math.ceil((scrollTop + clientHeight) / ITEM_HEIGHT) + 3,
  );

  const visibleRoomIds: string[] = [];
  for (let i = firstIdx; i <= lastIdx; i++) {
    const c = contacts.value[i];
    if (c) visibleRoomIds.push(c.id);
  }
  if (visibleRoomIds.length === 0) return;

  // Load profiles via room member resolution (same as chat list)
  chatStore.loadProfilesForRoomIds(visibleRoomIds);

  // For contacts with unresolved names, eagerly load members from Matrix server
  // (loadMembersForRooms calls loadMembersIfNeeded → updateDisplayNames → re-triggers loadProfilesForRoomIds)
  const needMembers: string[] = [];
  for (let i = firstIdx; i <= lastIdx; i++) {
    const c = contacts.value[i];
    if (c && (!c.name || isUnresolvedName(c.name))) needMembers.push(c.id);
  }
  if (needMembers.length > 0) chatStore.loadMembersForRooms(needMembers);
};

let scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const onScrollerScroll = () => {
  if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
  scrollDebounceTimer = setTimeout(loadVisibleContacts, 100);
};

// Attach native scroll listener to RecycleScroller's root element
let scrollEl: HTMLElement | null = null;
const attachScrollListener = () => {
  if (scrollEl) scrollEl.removeEventListener("scroll", onScrollerScroll);
  scrollEl = (scrollerRef.value?.$el as HTMLElement) ?? null;
  scrollEl?.addEventListener("scroll", onScrollerScroll, { passive: true });
};

watch(scrollerRef, (val) => {
  if (val) {
    nextTick(() => {
      attachScrollListener();
      loadVisibleContacts();
    });
  }
});

onMounted(() => {
  nextTick(loadVisibleContacts);
  // Retry after layout settles (tab transition)
  setTimeout(loadVisibleContacts, 350);
});

onBeforeUnmount(() => {
  if (scrollEl) scrollEl.removeEventListener("scroll", onScrollerScroll);
  if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
});

const handleSelect = (roomId: string) => {
  chatStore.setActiveRoom(roomId);
  emit("selectRoom");
};

const toggleSearch = () => {
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value) searchQuery.value = "";
};
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div
      class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-grad-0 px-4"
    >
      <span class="flex-1 text-base font-semibold text-text-color">{{ t("nav.contacts") }}</span>
      <button
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        @click="toggleSearch"
      >
        <svg
          v-if="!searchOpen"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <svg
          v-else
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <!-- Search bar -->
    <div v-if="searchOpen" class="shrink-0 border-b border-neutral-grad-0 px-3 py-2">
      <input
        v-model="searchQuery"
        type="text"
        :placeholder="t('contacts.searchPlaceholder')"
        class="h-9 w-full rounded-lg bg-neutral-grad-0 px-3 text-sm text-text-color outline-none placeholder:text-text-on-main-bg-color focus:ring-1 focus:ring-color-bg-ac"
        autofocus
      />
    </div>

    <!-- List -->
    <div class="flex-1 overflow-hidden">
      <!-- Skeleton while rooms haven't loaded yet -->
      <div v-if="contacts.length === 0 && !chatStore.roomsInitialized" class="space-y-1 p-2">
        <div v-for="i in 5" :key="i" class="flex items-center gap-3 px-4 py-2.5">
          <div class="h-10 w-10 shrink-0 animate-pulse rounded-full bg-neutral-grad-2" />
          <div class="h-4 w-24 animate-pulse rounded bg-neutral-grad-2" />
        </div>
      </div>
      <div
        v-else-if="contacts.length === 0"
        class="p-6 text-center text-sm text-text-on-main-bg-color"
      >
        {{ searchQuery.trim() ? t("contacts.noFound") : t("contacts.noYet") }}
      </div>
      <RecycleScroller
        v-else
        ref="scrollerRef"
        :items="contacts"
        :item-size="ITEM_HEIGHT"
        key-field="_key"
        class="h-full"
      >
        <template #default="{ item }">
          <button
            class="btn-press flex w-full items-center gap-3 px-4 py-2.5 transition-colors hover:bg-neutral-grad-0"
            :style="{ height: ITEM_HEIGHT + 'px' }"
            @click="handleSelect((item as ContactItem).id)"
          >
            <div v-if="(item as ContactItem).deleted" class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-grad-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="17" y1="8" x2="23" y2="14" /><line x1="23" y1="8" x2="17" y2="14" />
              </svg>
            </div>
            <Avatar
              v-else
              :src="(item as ContactItem).image"
              :name="(item as ContactItem).name || (item as ContactItem).address || '?'"
              size="md"
            />
            <span v-if="(item as ContactItem).deleted" class="truncate text-[15px] italic text-text-on-main-bg-color">
              {{ (item as ContactItem).name }}
            </span>
            <span v-else-if="!(item as ContactItem).name" class="inline-block h-4 w-24 animate-pulse rounded bg-neutral-grad-2" />
            <span v-else class="truncate text-[15px] font-medium text-text-color">
              {{ (item as ContactItem).name }}
            </span>
          </button>
        </template>
      </RecycleScroller>
    </div>
  </div>
</template>
