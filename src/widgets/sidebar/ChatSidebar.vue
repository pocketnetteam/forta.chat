<script setup lang="ts">
import { ContactList, ContactSearch, FolderTabs } from "@/features/contacts";
import { ChannelList } from "@/features/channels";
import { useChannelStore } from "@/entities/channel";
import { InviteModal } from "@/features/invite";
import { useWalletStore, formatPkoin } from "@/features/wallet";
import { useChatStore } from "@/entities/chat";
import { ConnectionStatusHeader } from "@/features/sync-status";
import { RoomListSkeleton } from "@/shared/ui/skeleton";
import { SelectionBar, useSelectionStore } from "@/features/selection";
import SwipeableTabs from "@/features/contacts/ui/SwipeableTabs.vue";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
import BottomTabBar from "./ui/BottomTabBar.vue";
import ContactsPanel from "./ui/ContactsPanel.vue";
import SettingsPanel from "./ui/SettingsPanel.vue";
import { useSidebarTab } from "./model/use-sidebar-tab";
import type { SidebarTab } from "./model/use-sidebar-tab";

const emit = defineEmits<{ selectRoom: []; newGroup: [] }>();
const chatStore = useChatStore();
const channelStore = useChannelStore();
const selectionStore = useSelectionStore();
const tabProgress = ref<number | undefined>(undefined);

useAndroidBackHandler("chat-selection", 92, () => {
  if (selectionStore.isSelectionMode) {
    selectionStore.deactivate();
    return true;
  }
  return false;
});

onMounted(() => {
  chatStore.loadCachedRooms();
  channelStore.fetchChannels(true);
});

const { t } = useI18n();
const { activeTab, setTab } = useSidebarTab();

const sidebarSearchQuery = ref("");

const searchPlaceholder = computed(() => {
  const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (isMobile) return t("contactSearch.placeholderShort");
  const isMac = navigator.platform?.startsWith("Mac") || navigator.userAgent.includes("Mac");
  const shortcut = isMac ? "⌘K" : "Ctrl+K";
  return `${t("contactSearch.placeholderShort")} (${shortcut})`;
});
const activeFilter = ref<"all" | "personal" | "groups" | "invites" | "channels">("all");

const bulkDeleteConfirm = ref(false);

const handleSelectionAction = (type: "delete" | "read" | "pin" | "mute") => {
  const ids = [...selectionStore.selectedIds];
  switch (type) {
    case "read":
      ids.forEach((id) => chatStore.markRoomAsRead(id));
      selectionStore.deactivate();
      break;
    case "pin":
      ids.forEach((id) => chatStore.togglePinRoom(id));
      selectionStore.deactivate();
      break;
    case "mute":
      ids.forEach((id) => chatStore.toggleMuteRoom(id));
      selectionStore.deactivate();
      break;
    case "delete":
      bulkDeleteConfirm.value = true;
      break;
  }
};

const confirmBulkDelete = () => {
  const ids = [...selectionStore.selectedIds];
  ids.forEach((id) => chatStore.removeRoom(id));
  selectionStore.deactivate();
  bulkDeleteConfirm.value = false;
};

const visibleTabValues = computed(() => {
  const tabs: string[] = ["all", "personal", "groups"];
  if (chatStore.inviteCount > 0) tabs.push("invites");
  if (channelStore.channels.length > 0) tabs.push("channels");
  return tabs;
});

// Sidebar tab slide direction
const sidebarTabOrder: SidebarTab[] = ["contacts", "chats", "settings"];
const tabSlideDir = ref<"left" | "right">("left");

watch(activeTab, (newVal, oldVal) => {
  tabSlideDir.value =
    sidebarTabOrder.indexOf(newVal) > sidebarTabOrder.indexOf(oldVal) ? "left" : "right";
});

// Show skeleton until rooms appear from ANY source (Dexie cache or Matrix sync).
// Uses computed so it re-activates on account switch (cleanup resets roomsInitialized).
const roomsLoading = computed(() =>
  chatStore.sortedRooms.length === 0 && !chatStore.roomsInitialized,
);

// Auto-switch away from "invites" tab when no invites remain
watch(
  () => chatStore.inviteCount,
  (count) => {
    if (count === 0 && activeFilter.value === "invites") {
      activeFilter.value = "all";
    }
  },
);

// Auto-switch away from "channels" tab when no channels remain
watch(
  () => channelStore.channels.length,
  (count) => {
    if (count === 0 && activeFilter.value === "channels") {
      activeFilter.value = "all";
    }
  },
);

const handleSelectRoom = () => {
  sidebarSearchQuery.value = "";
  emit("selectRoom");
};

const handleRoomCreated = () => {
  sidebarSearchQuery.value = "";
  emit("selectRoom");
};

const handleSelectMessage = (payload: { roomId: string; messageId: string }) => {
  chatStore.setActiveRoom(payload.roomId);
  sidebarSearchQuery.value = "";
  emit("selectRoom");
  // Note: scrolling to message will be handled by the chat window
};

const showInviteModal = ref(false);

// Wallet in header
const walletStore = useWalletStore();
</script>

<template>
  <aside
    class="flex h-full flex-col border-r border-neutral-grad-0 bg-chat-sidebar"
    aria-label="Chat sidebar"
  >
    <div class="relative min-h-0 flex-1 overflow-hidden">
      <transition :name="'sidebar-slide-' + tabSlideDir" mode="out-in">
        <!-- CHATS tab -->
        <div
          v-if="activeTab === 'chats'"
          key="chats"
          class="flex h-full flex-col"
        >
        <!-- Header -->
        <transition name="header-swap" mode="out-in">
          <SelectionBar
            v-if="selectionStore.isSelectionMode"
            key="selection"
            :count="selectionStore.count"
            @cancel="selectionStore.deactivate()"
            @action="handleSelectionAction"
          />
          <div
            v-else
            key="header"
            class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-grad-0 px-3"
          >
            <ConnectionStatusHeader />

            <!-- PKOIN Wallet -->
            <button
              v-if="walletStore.isAvailable"
              class="btn-press flex h-9 items-center gap-1.5 rounded-full bg-neutral-grad-0 px-2.5 text-text-color transition-colors hover:bg-neutral-grad-2/30"
              :title="t('settings.wallet')"
              @click="walletStore.refresh()"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 18 18"
                fill="currentColor"
                class="shrink-0 text-color-txt-ac"
              >
                <path fill-rule="evenodd" clip-rule="evenodd" d="M17.2584 1.97869L15.182 0L12.7245 2.57886C11.5308 1.85218 10.1288 1.43362 8.62907 1.43362C7.32722 1.43362 6.09904 1.74902 5.01676 2.30756L2.81787 6.45386e-05L0.741455 1.97875L2.73903 4.07498C1.49651 5.46899 0.741455 7.30694 0.741455 9.32124C0.741455 11.1753 1.38114 12.8799 2.45184 14.2264L0.741455 16.0213L2.81787 18L4.61598 16.1131C5.79166 16.8092 7.1637 17.2088 8.62907 17.2088C10.2903 17.2088 11.8317 16.6953 13.1029 15.8182L15.182 18L17.2584 16.0213L15.1306 13.7884C16.0049 12.5184 16.5167 10.9796 16.5167 9.32124C16.5167 7.50123 15.9003 5.8252 14.8648 4.49052L17.2584 1.97869ZM3.5551 9.32124C3.5551 12.1235 5.82679 14.3952 8.62907 14.3952C11.4313 14.3952 13.703 12.1235 13.703 9.32124C13.703 6.51896 11.4313 4.24727 8.62907 4.24727C5.82679 4.24727 3.5551 6.51896 3.5551 9.32124Z" />
              </svg>
              <span
                v-if="walletStore.status === 'loading'"
                class="text-xs text-text-on-main-bg-color animate-pulse"
              >...</span>
              <span
                v-else-if="walletStore.balance !== null"
                class="text-xs font-semibold text-color-txt-ac"
              >{{ formatPkoin(walletStore.balance) }}</span>
            </button>

            <!-- New Group -->
            <button
              class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
              :title="t('nav.newGroup')"
              :aria-label="t('nav.newGroup')"
              @click="emit('newGroup')"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </button>
          </div>
        </transition>

        <!-- Always-visible search input -->
        <div v-if="!selectionStore.isSelectionMode" class="shrink-0 px-3 pb-2 pt-2">
          <div class="relative">
            <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-on-main-bg-color" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              :value="sidebarSearchQuery"
              :placeholder="searchPlaceholder"
              class="w-full rounded-lg bg-chat-input-bg py-2 pl-8 pr-8 text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
              @input="sidebarSearchQuery = ($event.target as HTMLInputElement).value"
            />
            <button
              v-if="sidebarSearchQuery"
              class="absolute right-2 top-1/2 -translate-y-1/2 text-text-on-main-bg-color hover:text-text-color"
              @click="sidebarSearchQuery = ''"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Conditional: search results OR normal list -->
        <template v-if="sidebarSearchQuery.trim()">
          <ContactSearch
            :query="sidebarSearchQuery"
            class="flex-1 overflow-y-auto"
            @room-created="handleRoomCreated"
            @select-message="handleSelectMessage"
            @clear="sidebarSearchQuery = ''"
          />
        </template>
        <template v-else>
          <FolderTabs v-model="activeFilter" :scroll-progress="tabProgress" />
          <div class="relative flex-1 overflow-hidden">
            <RoomListSkeleton v-if="roomsLoading" :first-load="true" />
            <SwipeableTabs
              v-else
              v-model="activeFilter"
              :tabs="visibleTabValues"
              :disabled="selectionStore.isSelectionMode"
              class="h-full"
              @scroll-progress="tabProgress = $event"
            >
              <template #all>
                <ContactList
                  filter="all"
                  class="h-full overflow-y-auto"
                  @select-room="handleSelectRoom"
                  @select-channel="handleSelectRoom"
                />
              </template>
              <template #personal>
                <ContactList
                  filter="personal"
                  class="h-full overflow-y-auto"
                  @select-room="handleSelectRoom"
                />
              </template>
              <template #groups>
                <ContactList
                  filter="groups"
                  class="h-full overflow-y-auto"
                  @select-room="handleSelectRoom"
                />
              </template>
              <template #invites>
                <ContactList
                  filter="invites"
                  class="h-full overflow-y-auto"
                  @select-room="handleSelectRoom"
                />
              </template>
              <template #channels>
                <ChannelList
                  class="h-full overflow-y-auto"
                  @select-channel="handleSelectRoom"
                />
              </template>
            </SwipeableTabs>
          </div>
        </template>
      </div>

        <!-- CONTACTS tab -->
        <ContactsPanel
          v-else-if="activeTab === 'contacts'"
          key="contacts"
          class="h-full"
          @select-room="handleSelectRoom"
        />

        <!-- SETTINGS tab -->
        <SettingsPanel
          v-else
          key="settings"
          class="h-full"
        />
      </transition>
    </div>

    <!-- Invite banner -->
    <button
      class="invite-fab hide-on-keyboard btn-press mx-2 mb-1.5 flex shrink-0 items-center justify-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-bold text-text-on-bg-ac-color shadow-lg transition-all active:scale-[0.97]"
      :title="t('invite.fab')"
      @click="showInviteModal = true"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" />
        <line x1="22" y1="11" x2="16" y2="11" />
      </svg>
      <span>{{ t("invite.fab") }}</span>
    </button>

    <!-- Bulk delete confirmation -->
    <Teleport to="body">
      <transition name="fade">
        <div
          v-if="bulkDeleteConfirm"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          @click.self="bulkDeleteConfirm = false"
        >
          <div class="w-full max-w-xs rounded-xl bg-background-total-theme p-5 shadow-xl">
            <h3 class="mb-3 text-base font-semibold text-text-color">{{ t("selection.deleteTitle") }}</h3>
            <p class="mb-4 text-sm text-text-on-main-bg-color">
              {{ t("selection.deleteConfirm", { count: selectionStore.count }) }}
            </p>
            <div class="flex gap-2">
              <button
                class="flex-1 rounded-lg bg-neutral-grad-0 px-4 py-2.5 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
                @click="bulkDeleteConfirm = false"
              >{{ t("contactList.cancel") }}</button>
              <button
                class="flex-1 rounded-lg bg-color-bad px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bad/90"
                @click="confirmBulkDelete"
              >{{ t("contactList.delete") }}</button>
            </div>
          </div>
        </div>
      </transition>
    </Teleport>

    <InviteModal :show="showInviteModal" @close="showInviteModal = false" />

    <BottomTabBar :model-value="activeTab" @update:model-value="setTab" />
  </aside>
</template>

<style scoped>
/* Header swap transition */
.header-swap-enter-active,
.header-swap-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.header-swap-enter-from { opacity: 0; transform: translateY(-8px); }
.header-swap-leave-to { opacity: 0; transform: translateY(8px); }

/* Sidebar tab slides (Contacts ↔ Chats ↔ Settings) */
.sidebar-slide-left-enter-active,
.sidebar-slide-left-leave-active,
.sidebar-slide-right-enter-active,
.sidebar-slide-right-leave-active {
  transition: transform 0.2s ease, opacity 0.15s ease;
}
.sidebar-slide-left-leave-active,
.sidebar-slide-right-leave-active {
  position: absolute;
  inset: 0;
}
.sidebar-slide-left-enter-from {
  transform: translateX(30%);
  opacity: 0;
}
.sidebar-slide-left-leave-to {
  transform: translateX(-30%);
  opacity: 0;
}
.sidebar-slide-right-enter-from {
  transform: translateX(-30%);
  opacity: 0;
}
.sidebar-slide-right-leave-to {
  transform: translateX(30%);
  opacity: 0;
}

/* Invite FAB — gradient + aggressive glow pulse */
.invite-fab {
  background: linear-gradient(135deg, rgb(var(--color-bg-ac-bright)), rgb(var(--color-bg-ac-2)));
  animation: invite-pulse 2s ease-in-out infinite;
}
@keyframes invite-pulse {
  0%, 100% { box-shadow: 0 4px 16px rgba(var(--color-bg-ac-bright), 0.4), 0 0 0 0 rgba(var(--color-bg-ac-2), 0); }
  50% { box-shadow: 0 6px 28px rgba(var(--color-bg-ac-bright), 0.6), 0 0 0 6px rgba(var(--color-bg-ac-2), 0.15); }
}

@media (prefers-reduced-motion: reduce) {
  .header-swap-enter-active,
  .header-swap-leave-active,
  .sidebar-slide-left-enter-active,
  .sidebar-slide-left-leave-active,
  .sidebar-slide-right-enter-active,
  .sidebar-slide-right-leave-active {
    transition: none;
  }
  .invite-fab {
    animation: none;
  }
}
</style>
