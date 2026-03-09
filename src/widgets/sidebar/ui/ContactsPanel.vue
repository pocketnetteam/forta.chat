<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { useUserStore } from "@/entities/user/model";
import Avatar from "@/shared/ui/avatar/Avatar.vue";

const chatStore = useChatStore();
const userStore = useUserStore();
const emit = defineEmits<{ selectRoom: [] }>();

const { t } = useI18n();
const searchQuery = ref("");
const searchOpen = ref(false);

const contacts = computed(() => {
  const list = chatStore.sortedRooms
    .filter((r) => !r.isGroup && r.membership !== "invite")
    .map((room) => {
      const address = room.avatar?.startsWith("__pocketnet__:")
        ? room.avatar.replace("__pocketnet__:", "")
        : undefined;
      const user = address ? userStore.getUser(address) : undefined;
      return {
        id: room.id,
        name: user?.name || room.name,
        address,
        image: user?.image,
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

// Eagerly load user profiles for all contacts
watch(
  contacts,
  (list) => {
    for (const c of list) {
      if (c.address) userStore.loadUserIfMissing(c.address);
    }
  },
  { immediate: true },
);

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
    <div class="flex-1 overflow-y-auto">
      <div
        v-if="contacts.length === 0"
        class="p-6 text-center text-sm text-text-on-main-bg-color"
      >
        {{ searchQuery.trim() ? t("contacts.noFound") : t("contacts.noYet") }}
      </div>
      <button
        v-for="contact in contacts"
        :key="contact.id"
        class="btn-press flex w-full items-center gap-3 px-4 py-2.5 transition-colors hover:bg-neutral-grad-0"
        @click="handleSelect(contact.id)"
      >
        <Avatar
          :src="contact.image"
          :name="contact.name || contact.address || '?'"
          size="md"
        />
        <span class="truncate text-[15px] font-medium text-text-color">
          {{ contact.name }}
        </span>
      </button>
    </div>
  </div>
</template>

