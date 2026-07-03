<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { useUserStore } from "@/entities/user/model";
import UserAvatar from "@/entities/user/ui/UserAvatar.vue";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { isUnresolvedName } from "@/entities/chat/lib/chat-helpers";
import { ContactSearch } from "@/features/contacts";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";

const chatStore = useChatStore();
const userStore = useUserStore();
const emit = defineEmits<{ selectRoom: [] }>();
const { resolve: resolveRoomName } = useResolvedRoomName();

const { t } = useI18n();
const searchQuery = ref("");
const searchOpen = ref(false);

// WEE-65 (H4 / #168, #545, #819): explicit "Add contact" entry. The Contacts
// tab previously only filtered EXISTING DM rooms locally, so there was no
// discoverable way to find a new user and start a chat from here. Add-mode
// reuses the proven global directory search (`ContactSearch`) which already
// wires `useContacts.searchUsers` (RPC → Matrix → local) + `getOrCreateRoom`,
// so picking a user creates/opens the DM. Self-contained: opening add-mode
// closes the local filter, and a created room hands off via `selectRoom`.
const addMode = ref(false);
const addQuery = ref("");

const openAddContact = () => {
  searchOpen.value = false;
  searchQuery.value = "";
  addQuery.value = "";
  addMode.value = true;
};

const closeAddContact = () => {
  addMode.value = false;
  addQuery.value = "";
};

const handleAddRoomCreated = (roomId: string) => {
  chatStore.setActiveRoom(roomId);
  closeAddContact();
  emit("selectRoom");
};

// ContactSearch also surfaces chat/message hits; tapping one in add-mode should
// open that room rather than no-op.
const handleAddSelectMessage = (payload: { roomId: string }) => {
  chatStore.setActiveRoom(payload.roomId);
  closeAddContact();
  emit("selectRoom");
};

interface ContactItem {
  id: string;
  _key: string;
  name: string;
  address: string | undefined;
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
      return {
        id: room.id,
        _key: room.id,
        name: user?.name || (isUnresolvedName(resolved) ? "" : resolved),
        address,
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
    <!-- Header (browse mode) -->
    <div
      v-if="!addMode"
      class="flex h-14 shrink-0 items-center gap-1 border-b border-neutral-grad-0 px-4"
    >
      <span class="flex-1 text-base font-semibold text-text-color">{{ t("nav.contacts") }}</span>
      <button
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :title="t('contacts.addContact')"
        :aria-label="t('contacts.addContact')"
        @click="openAddContact"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <line x1="19" y1="8" x2="19" y2="14" />
          <line x1="22" y1="11" x2="16" y2="11" />
        </svg>
      </button>
      <button
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :aria-label="t('contacts.searchPlaceholder')"
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

    <!-- Header (add-contact mode) -->
    <div
      v-else
      class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-grad-0 px-4"
    >
      <button
        class="btn-press flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :aria-label="t('contactList.cancel')"
        @click="closeAddContact"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
      </button>
      <span class="flex-1 text-base font-semibold text-text-color">{{ t("contacts.addContact") }}</span>
    </div>

    <!-- Add-contact mode: directory search + create DM (reuses ContactSearch) -->
    <template v-if="addMode">
      <div class="shrink-0 border-b border-neutral-grad-0 px-3 py-2">
        <input
          v-model="addQuery"
          type="text"
          :placeholder="t('contacts.addPlaceholder')"
          class="h-9 w-full rounded-lg bg-neutral-grad-0 px-3 text-sm text-text-color outline-none placeholder:text-text-on-main-bg-color focus:ring-1 focus:ring-color-bg-ac"
          autofocus
        />
      </div>
      <!-- Render results only once there's a query — ContactSearch's empty
           state ("No chats or users found") would otherwise show on an empty
           input. Until then, show a neutral prompt. -->
      <ContactSearch
        v-if="addQuery.trim()"
        :query="addQuery"
        class="flex-1 overflow-y-auto py-1"
        @room-created="handleAddRoomCreated"
        @select-message="handleAddSelectMessage"
        @clear="addQuery = ''"
      />
      <div
        v-else
        class="flex flex-1 items-start justify-center p-6 text-center text-sm text-text-on-main-bg-color"
      >
        {{ t("contacts.addPlaceholder") }}
      </div>
    </template>

    <!-- Search bar -->
    <div v-if="!addMode && searchOpen" class="shrink-0 border-b border-neutral-grad-0 px-3 py-2">
      <input
        v-model="searchQuery"
        type="text"
        :placeholder="t('contacts.searchPlaceholder')"
        class="h-9 w-full rounded-lg bg-neutral-grad-0 px-3 text-sm text-text-color outline-none placeholder:text-text-on-main-bg-color focus:ring-1 focus:ring-color-bg-ac"
        autofocus
      />
    </div>

    <!-- List -->
    <div v-if="!addMode" class="flex-1 overflow-hidden">
      <!-- Skeleton while rooms haven't loaded yet -->
      <div v-if="contacts.length === 0 && !chatStore.roomsInitialized" class="space-y-1 p-2">
        <div v-for="i in 5" :key="i" class="flex items-center gap-3 px-4 py-2.5">
          <div class="h-10 w-10 shrink-0 animate-pulse rounded-full bg-neutral-grad-2" />
          <div class="h-4 w-24 animate-pulse rounded bg-neutral-grad-2" />
        </div>
      </div>
      <div
        v-else-if="contacts.length === 0"
        class="flex flex-col items-center gap-3 p-6 text-center text-sm text-text-on-main-bg-color"
      >
        <span>{{ searchQuery.trim() ? t("contacts.noFound") : t("contacts.noYet") }}</span>
        <button
          v-if="!searchQuery.trim()"
          class="btn-press inline-flex items-center gap-2 rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1"
          @click="openAddContact"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="19" y1="8" x2="19" y2="14" />
            <line x1="22" y1="11" x2="16" y2="11" />
          </svg>
          {{ t("contacts.addContact") }}
        </button>
      </div>
      <RecycleScroller
        v-else
        ref="scrollerRef"
        :items="contacts"
        :item-size="ITEM_HEIGHT"
        :style="{ '--recycle-item-size': `${ITEM_HEIGHT}px` }"
        key-field="_key"
        class="h-full"
      >
        <template #default="{ item }">
          <button
            class="btn-press flex w-full items-center gap-3 px-4 py-2.5 transition-colors hover:bg-neutral-grad-0"
            :style="{ height: ITEM_HEIGHT + 'px' }"
            @click="handleSelect((item as ContactItem).id)"
          >
            <UserAvatar
              v-if="(item as ContactItem).address"
              :address="(item as ContactItem).address!"
              size="md"
            />
            <Avatar
              v-else
              :name="(item as ContactItem).name || '?'"
              size="md"
            />
            <span v-if="!(item as ContactItem).name" class="inline-block h-4 w-24 animate-pulse rounded bg-neutral-grad-2" />
            <span v-else class="truncate text-[15px] font-medium text-text-color">
              {{ (item as ContactItem).name }}
            </span>
          </button>
        </template>
      </RecycleScroller>
    </div>
  </div>
</template>
