<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import type { Message } from "@/entities/chat";
import { UserAvatar } from "@/entities/user";
import { useAuthStore } from "@/entities/auth";
import { hexEncode, hexDecode } from "@/shared/lib/matrix/functions";
import { MATRIX_SERVER } from "@/shared/config";
import { useContacts } from "@/features/contacts/model/use-contacts";
import { matrixIdToAddress, isUnresolvedName } from "@/entities/chat/lib/chat-helpers";
import { useFileDownload } from "@/features/messaging/model/use-file-download";
import { useCallService } from "@/features/video-calls/model/call-service";
import ContextMenu from "@/shared/ui/context-menu/ContextMenu.vue";
import type { ContextMenuItem } from "@/shared/ui/context-menu/ContextMenu.vue";
import Toggle from "@/shared/ui/toggle/Toggle.vue";
import ChatInfoGallery from "./ChatInfoGallery.vue";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";

interface Props {
  show: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
  openSearch: [];
  goToMessage: [messageId: string];
}>();

const { t } = useI18n();
const chatStore = useChatStore();
const authStore = useAuthStore();
const callService = useCallService();
const room = computed(() => chatStore.activeRoom);
const { resolve: resolveRoomName } = useResolvedRoomName();
const roomDisplayName = computed(() => resolveRoomName(room.value));

// ── Screen navigation ──
const screen = ref<"main" | "gallery">("main");
const galleryInitialTab = ref<"media" | "files" | "links" | "voice">("media");

// Reset screen when panel closes
watch(() => props.show, (v) => {
  if (!v) screen.value = "main";
});

// ── Media / file counts ──
const mediaCount = computed(() => {
  if (!room.value) return 0;
  return chatStore.activeMessages.filter(m => m.type === "image" || m.type === "video").length;
});

const fileCount = computed(() => {
  if (!room.value) return 0;
  return chatStore.activeMessages.filter(m => m.type === "file" || m.type === "audio").length;
});

// ── Invite link (group sharing) ──
const roomPublic = ref(false);
const togglingPublic = ref(false);
const linkCopied = ref(false);

const refreshRoomPublic = () => {
  if (room.value?.isGroup) {
    roomPublic.value = chatStore.isRoomPublic(room.value.id);
  }
};

watch(room, refreshRoomPublic, { immediate: true });

const inviteLink = computed(() => {
  if (!room.value) return "";
  const base = window.location.origin + window.location.pathname;
  return `${base}#/join?room=${encodeURIComponent(room.value.id)}`;
});

const togglePublic = async () => {
  if (!room.value || togglingPublic.value) return;
  togglingPublic.value = true;
  const newVal = !roomPublic.value;
  const ok = await chatStore.setRoomPublic(room.value.id, newVal);
  if (ok) roomPublic.value = newVal;
  togglingPublic.value = false;
};

const copyInviteLink = async () => {
  await navigator.clipboard.writeText(inviteLink.value);
  linkCopied.value = true;
  setTimeout(() => linkCopied.value = false, 2000);
};

// ── Mute state ──
const isMuted = computed(() => {
  if (!room.value) return false;
  return chatStore.mutedRoomIds.has(room.value.id);
});

const toggleMute = () => {
  if (room.value) chatStore.toggleMuteRoom(room.value.id);
};

// ── Power levels ──
const powerLevels = computed(() => {
  if (!room.value) return { myLevel: 0, levels: {} };
  return chatStore.getRoomPowerLevels(room.value.id);
});

const isAdmin = computed(() => powerLevels.value.myLevel >= 50);

// room.members stores hex-encoded IDs — build Matrix ID directly without re-encoding
const getMemberPowerLevel = (hexId: string): number => {
  const matrixId = `@${hexId}:${MATRIX_SERVER}`;
  return powerLevels.value.levels[matrixId] ?? 0;
};

const isMemberAdmin = (hexId: string): boolean => getMemberPowerLevel(hexId) >= 50;

// My hex ID for self-check (room.members are hex-encoded)
const myHexId = computed(() => hexEncode(authStore.address ?? "").toLowerCase());

// ── Avatar edit ──
const avatarInputRef = ref<HTMLInputElement | null>(null);
const uploadingAvatar = ref(false);

const handleAvatarClick = () => {
  if (!isAdmin.value || !room.value?.isGroup) return;
  avatarInputRef.value?.click();
};

const handleAvatarChange = async (e: Event) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || !room.value) return;
  uploadingAvatar.value = true;
  await chatStore.setRoomAvatar(room.value.id, file);
  uploadingAvatar.value = false;
  // Reset input so the same file can be selected again
  if (avatarInputRef.value) avatarInputRef.value.value = "";
};

// ── Topic / description ──
const editingTopic = ref(false);
const topicDraft = ref("");
const savingTopic = ref(false);

const startEditTopic = () => {
  topicDraft.value = room.value?.topic ?? "";
  editingTopic.value = true;
};

const cancelEditTopic = () => {
  editingTopic.value = false;
};

const saveEditTopic = async () => {
  if (!room.value || savingTopic.value) return;
  savingTopic.value = true;
  await chatStore.setRoomTopic(room.value.id, topicDraft.value.trim());
  savingTopic.value = false;
  editingTopic.value = false;
};

// ── Add member overlay ──
const showAddMember = ref(false);
const { searchQuery: addSearchQuery, searchResults: addSearchResults, isSearching: addIsSearching, debouncedSearch: addDebouncedSearch } = useContacts();
const addingMember = ref(false);

const handleAddMemberSearch = (e: Event) => {
  const value = (e.target as HTMLInputElement).value;
  addSearchQuery.value = value;
  addDebouncedSearch(value);
};

// inviteMember expects raw address — search results give raw addresses
const handleAddMember = async (address: string) => {
  if (!room.value || addingMember.value) return;
  addingMember.value = true;
  const ok = await chatStore.inviteMember(room.value.id, address);
  addingMember.value = false;
  if (ok) {
    showAddMember.value = false;
    addSearchQuery.value = "";
  }
};

// ── Member actions — address here is a hex-encoded ID from room.members ──
const memberAction = ref<{ show: boolean; hexId: string; x: number; y: number }>({
  show: false, hexId: "", x: 0, y: 0,
});

const openMemberMenu = (e: MouseEvent, hexId: string) => {
  if (!isAdmin.value) return;
  if (hexId === myHexId.value) return; // can't manage self
  memberAction.value = { show: true, hexId, x: e.clientX, y: e.clientY };
};

const kickingMember = ref(false);

// kickMember expects raw address — decode hex before passing
const handleKickMember = async () => {
  if (!room.value || kickingMember.value) return;
  kickingMember.value = true;
  const rawAddr = hexDecode(memberAction.value.hexId);
  await chatStore.kickMember(room.value.id, rawAddr);
  kickingMember.value = false;
  memberAction.value.show = false;
};

const togglingAdmin = ref(false);

// setMemberPowerLevel expects raw address — decode hex before passing
const handleToggleAdmin = async () => {
  if (!room.value || togglingAdmin.value) return;
  togglingAdmin.value = true;
  const hexId = memberAction.value.hexId;
  const rawAddr = hexDecode(hexId);
  const currentLevel = getMemberPowerLevel(hexId);
  const newLevel = currentLevel >= 50 ? 0 : 50;
  await chatStore.setMemberPowerLevel(room.value.id, rawAddr, newLevel);
  togglingAdmin.value = false;
  memberAction.value.show = false;
};

// ── Ban / Mute ──
const banningMember = ref(false);
const mutingMember = ref(false);

const handleBanMember = async () => {
  if (!room.value || banningMember.value) return;
  banningMember.value = true;
  const rawAddr = hexDecode(memberAction.value.hexId);
  await chatStore.banMember(room.value.id, rawAddr);
  banningMember.value = false;
  memberAction.value.show = false;
};

const handleToggleMute = async () => {
  if (!room.value || mutingMember.value) return;
  mutingMember.value = true;
  const rawAddr = hexDecode(memberAction.value.hexId);
  const muted = chatStore.isMemberMuted(room.value.id, memberAction.value.hexId);
  await chatStore.muteMember(room.value.id, rawAddr, !muted);
  mutingMember.value = false;
  memberAction.value.show = false;
};

const isActionMemberMuted = computed(() => {
  if (!room.value || !memberAction.value.hexId) return false;
  return chatStore.isMemberMuted(room.value.id, memberAction.value.hexId);
});

// ── Banned members ──
const bannedMembers = computed(() => {
  if (!room.value) return [];
  return chatStore.getBannedMembers(room.value.id);
});

const unbanningUser = ref<string | null>(null);

const handleUnban = async (userId: string) => {
  if (!room.value || unbanningUser.value) return;
  unbanningUser.value = userId;
  await chatStore.unbanMember(room.value.id, userId);
  unbanningUser.value = null;
};

const memberMenuStyle = computed(() => {
  const x = Math.min(memberAction.value.x, (window?.innerWidth ?? 800) - 200);
  const y = Math.min(memberAction.value.y, (window?.innerHeight ?? 600) - 250);
  return { left: `${x}px`, top: `${y}px` };
});

// ── Leave / Delete / Clear / Block — track which action was triggered ──
const confirmAction = ref<"leave" | "delete" | "clear" | "block" | null>(null);

const handleLeaveGroup = () => {
  if (!room.value) return;
  chatStore.leaveGroup(room.value.id);
  confirmAction.value = null;
  emit("close");
};

const handleDeleteChat = () => {
  if (!room.value) return;
  chatStore.removeRoom(room.value.id);
  confirmAction.value = null;
  emit("close");
};

// ── Call initiation ──
const startCall = (type: "voice" | "video") => {
  if (!room.value) return;
  callService.startCall(room.value.id, type);
  emit("close");
};

// ── More context menu ──
const showMoreMenu = ref(false);
const moreMenuPos = ref({ x: 0, y: 0 });

const openMoreMenu = (e: MouseEvent) => {
  moreMenuPos.value = { x: e.clientX, y: e.clientY };
  showMoreMenu.value = true;
};

// SVG icon strings for ContextMenu items (v-html)
const SEARCH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const BELL_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
const VIDEO_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
const BROOM_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const BAN_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';
const LOGOUT_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
const TRASH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

const moreMenuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = [];
  items.push({ label: t("chatInfo.searchInChat"), icon: SEARCH_ICON, action: "search" });
  items.push({
    label: isMuted.value ? t("chatInfo.unmuteNotifications") : t("chatInfo.muteNotifications"),
    icon: BELL_ICON,
    action: "toggleMute",
  });
  if (!room.value?.isGroup) {
    items.push({ label: t("chatInfo.videoCall"), icon: VIDEO_ICON, action: "videoCall" });
  }
  items.push({ label: t("chatInfo.clearHistory"), icon: BROOM_ICON, action: "clearHistory" });
  if (!room.value?.isGroup) {
    items.push({ label: t("chatInfo.blockUser"), icon: BAN_ICON, action: "block", danger: true });
    items.push({ label: t("chatInfo.deleteChat"), icon: TRASH_ICON, action: "deleteChat", danger: true });
  } else {
    items.push({ label: t("chatInfo.leaveGroup"), icon: LOGOUT_ICON, action: "leave", danger: true });
    if (isAdmin.value) {
      items.push({ label: t("chatInfo.deleteGroup"), icon: TRASH_ICON, action: "deleteGroup", danger: true });
    }
  }
  return items;
});

const handleMoreAction = (action: string) => {
  showMoreMenu.value = false;
  switch (action) {
    case "search": emit("close"); emit("openSearch"); break;
    case "toggleMute": toggleMute(); break;
    case "videoCall": startCall("video"); break;
    case "clearHistory": confirmAction.value = "clear"; break;
    case "block": confirmAction.value = "block"; break;
    case "deleteChat": confirmAction.value = "delete"; break;
    case "leave": confirmAction.value = "leave"; break;
    case "deleteGroup": confirmAction.value = "delete"; break;
  }
};

// ── Peer info (1:1 DM) ──
const peerAddress = computed(() => {
  if (!room.value || room.value.isGroup) return null;
  const myHex = myHexId.value;
  const other = room.value.members.find(m => m !== myHex);
  return other ? hexDecode(other) : null;
});

const peerData = ref<{ name: string; about: string; site: string; image: string } | null>(null);

watch(() => peerAddress.value, async (addr) => {
  if (!addr) { peerData.value = null; return; }
  await authStore.loadUsersInfo([addr]);
  peerData.value = authStore.getBastyonUserData(addr) ?? null;
}, { immediate: true });

// Copy address to clipboard
const copiedAddress = ref(false);
const copyAddress = async () => {
  if (!peerAddress.value) return;
  await navigator.clipboard.writeText(peerAddress.value);
  copiedAddress.value = true;
  setTimeout(() => copiedAddress.value = false, 2000);
};

// ── Media preview (last 4 thumbnails) ──
const recentMedia = computed<Message[]>(() =>
  chatStore.activeMessages
    .filter(m => m.type === "image" || m.type === "video")
    .slice(-4)
    .reverse()
);

const { getState: getMediaState, download: downloadMedia } = useFileDownload();

const ensureMediaLoaded = (msg: Message) => {
  const state = getMediaState(msg.id);
  if (!state.objectUrl && !state.loading) downloadMedia(msg);
};

const openGallery = (tab: "media" | "files" | "links" | "voice" = "media") => {
  galleryInitialTab.value = tab;
  screen.value = "gallery";
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
        class="fixed right-0 top-0 z-50 h-full w-full bg-background-total-theme shadow-xl sm:w-[360px] sm:max-w-full"
        @click.stop
      >
        <div v-if="room" class="flex h-full flex-col">
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

          <!-- Screen: Main -->
          <div v-if="screen === 'main'" class="flex-1 overflow-y-auto">
            <!-- Avatar + Name -->
            <div class="flex flex-col items-center gap-3 p-6">
              <!-- Avatar with edit overlay for admin groups -->
              <div
                class="group relative"
                :class="isAdmin && room.isGroup ? 'cursor-pointer' : ''"
                @click="handleAvatarClick"
              >
                <UserAvatar
                  v-if="room.avatar?.startsWith('__pocketnet__:')"
                  :address="room.avatar.replace('__pocketnet__:', '')"
                  size="xl"
                />
                <Avatar v-else :src="room.avatar" :name="room.name" size="xl" />
                <!-- Camera overlay (admin + group only) -->
                <div
                  v-if="isAdmin && room.isGroup"
                  class="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <div v-if="uploadingAvatar" class="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <svg v-else width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </div>
                <input
                  ref="avatarInputRef"
                  type="file"
                  accept="image/*"
                  class="hidden"
                  @change="handleAvatarChange"
                />
              </div>
              <div class="text-center">
                <h2 v-if="isUnresolvedName(roomDisplayName)" class="mx-auto h-5 w-32 animate-pulse rounded bg-neutral-grad-2" />
                <h2 v-else class="text-lg font-semibold text-text-color">{{ roomDisplayName }}</h2>
                <p class="text-sm text-text-on-main-bg-color">
                  {{ room.isGroup ? t("info.members", { count: room.members.length }) : t("info.directMessage") }}
                </p>

                <!-- Topic / Description -->
                <template v-if="room.isGroup">
                  <div v-if="!editingTopic" class="mt-2">
                    <p v-if="room.topic" class="text-xs text-text-on-main-bg-color">{{ room.topic }}</p>
                    <button
                      v-if="isAdmin"
                      class="mt-1 text-xs text-color-bg-ac hover:underline"
                      @click="startEditTopic"
                    >
                      {{ room.topic ? t("chatInfo.editDescription") : t("chatInfo.addDescription") }}
                    </button>
                  </div>
                  <div v-else class="mt-2 w-full text-left">
                    <textarea
                      v-model="topicDraft"
                      class="w-full rounded-lg bg-chat-input-bg px-3 py-2 text-xs text-text-color outline-none placeholder:text-neutral-grad-2"
                      :placeholder="t('chatInfo.addDescription')"
                      rows="3"
                      maxlength="500"
                    />
                    <div class="mt-1 flex justify-end gap-2">
                      <button class="rounded px-2 py-1 text-xs text-text-on-main-bg-color hover:bg-neutral-grad-0" @click="cancelEditTopic">
                        {{ t("info.cancel") }}
                      </button>
                      <button
                        class="rounded bg-color-bg-ac px-2 py-1 text-xs text-white"
                        :disabled="savingTopic"
                        @click="saveEditTopic"
                      >
                        {{ savingTopic ? t("profile.saving") : t("profile.saveChanges") }}
                      </button>
                    </div>
                  </div>
                </template>
              </div>
            </div>

            <!-- Action buttons row -->
            <div class="flex items-center justify-center gap-6 pb-4">
              <!-- Chat button -->
              <button class="flex flex-col items-center gap-1" @click="emit('close')">
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac transition-colors hover:bg-color-bg-ac/20">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <span class="text-[11px] text-text-on-main-bg-color">{{ t("chatInfo.chat") }}</span>
              </button>

              <!-- Call button (1:1 only) -->
              <button v-if="!room.isGroup" class="flex flex-col items-center gap-1" @click="startCall('voice')">
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac transition-colors hover:bg-color-bg-ac/20">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                  </svg>
                </div>
                <span class="text-[11px] text-text-on-main-bg-color">{{ t("chatInfo.call") }}</span>
              </button>

              <!-- More button -->
              <button class="flex flex-col items-center gap-1" @click="openMoreMenu">
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac transition-colors hover:bg-color-bg-ac/20">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
                  </svg>
                </div>
                <span class="text-[11px] text-text-on-main-bg-color">{{ t("chatInfo.more") }}</span>
              </button>
            </div>

            <!-- Invite link section (group only, admin or already public) -->
            <div v-if="room.isGroup && (isAdmin || roomPublic)" class="border-t border-neutral-grad-0 px-4 py-3">
              <div class="mb-2 flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  <span class="text-sm font-medium text-text-color">{{ t("shareGroup.inviteLink") }}</span>
                </div>
                <div v-if="isAdmin" class="flex items-center gap-2">
                  <span class="text-[11px] text-text-on-main-bg-color">{{ t("shareGroup.publicGroup") }}</span>
                  <Toggle :model-value="roomPublic" size="sm" :disabled="togglingPublic" @update:model-value="togglePublic" />
                </div>
              </div>

              <template v-if="roomPublic">
                <div class="flex items-center gap-2">
                  <input
                    :value="inviteLink"
                    readonly
                    class="min-w-0 flex-1 rounded-lg bg-chat-input-bg px-3 py-2 text-xs text-text-color outline-none"
                    @click="($event.target as HTMLInputElement).select()"
                  />
                  <button
                    class="shrink-0 rounded-lg bg-color-bg-ac px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-color-bg-ac/90"
                    @click="copyInviteLink"
                  >
                    {{ linkCopied ? t("shareGroup.copied") : t("shareGroup.copyLink") }}
                  </button>
                </div>
                <p class="mt-1.5 text-[11px] text-text-on-main-bg-color">{{ t("shareGroup.publicGroupHint") }}</p>
              </template>
              <template v-else>
                <p class="text-xs text-text-on-main-bg-color">
                  {{ isAdmin ? t("shareGroup.enablePublic") : t("shareGroup.publicGroupHint") }}
                </p>
              </template>
            </div>

            <!-- Contact info section (1:1 DM only) -->
            <div v-if="!room.isGroup && peerData" class="border-t border-neutral-grad-0 px-4 py-3">
              <!-- About -->
              <div v-if="peerData.about" class="mb-3">
                <div class="mb-1 text-xs text-text-on-main-bg-color">{{ t("chatInfo.about") }}</div>
                <div class="text-sm text-text-color">{{ peerData.about }}</div>
              </div>
              <!-- Website -->
              <div v-if="peerData.site" class="mb-3">
                <div class="mb-1 text-xs text-text-on-main-bg-color">{{ t("chatInfo.website") }}</div>
                <a :href="peerData.site" target="_blank" class="text-sm text-color-txt-ac hover:underline">{{ peerData.site }}</a>
              </div>
              <!-- Bastyon Address -->
              <div v-if="peerAddress">
                <div class="mb-1 text-xs text-text-on-main-bg-color">{{ t("chatInfo.address") }}</div>
                <button class="group flex items-center gap-2 text-sm text-text-color" @click="copyAddress">
                  <span class="font-mono text-xs">{{ peerAddress }}</span>
                  <svg v-if="!copiedAddress" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-color-txt-gray transition-colors group-hover:text-text-on-main-bg-color">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span v-else class="text-xs text-color-good">{{ t("chatInfo.copied") }}</span>
                </button>
              </div>
              <!-- Profile link -->
              <div v-if="peerAddress" class="mt-3">
                <a
                  :href="`bastyon://user?address=${peerAddress}`"
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

            <!-- Notifications toggle -->
            <div class="border-t border-neutral-grad-0 px-4 py-3">
              <div class="flex w-full items-center justify-between">
                <div class="flex items-center gap-3">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                  <span class="text-sm text-text-color">{{ t("chatInfo.notifications") }}</span>
                </div>
                <Toggle :model-value="!isMuted" size="sm" @update:model-value="toggleMute" />
              </div>
            </div>

            <!-- Media preview section -->
            <div class="border-t border-neutral-grad-0 px-4 py-3">
              <button
                class="-mx-2 flex w-[calc(100%+16px)] items-center justify-between rounded-lg px-2 py-2 transition-colors hover:bg-neutral-grad-0"
                @click="openGallery('media')"
              >
                <span class="text-sm font-medium text-text-color">{{ t("chatInfo.mediaFilesLinks") }}</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <!-- Thumbnail preview (last 4) -->
              <div v-if="recentMedia.length > 0" class="mt-2 grid grid-cols-4 gap-1">
                <div
                  v-for="msg in recentMedia"
                  :key="msg.id"
                  class="aspect-square cursor-pointer overflow-hidden rounded-md bg-neutral-grad-0"
                  @click="openGallery('media')"
                  @vue:mounted="ensureMediaLoaded(msg)"
                >
                  <img
                    v-if="getMediaState(msg.id).objectUrl"
                    :src="getMediaState(msg.id).objectUrl!"
                    alt=""
                    class="h-full w-full object-cover"
                  />
                  <div v-else class="h-full w-full animate-pulse" />
                </div>
              </div>
            </div>

            <!-- Members (group only) -->
            <div v-if="room.isGroup" class="border-t border-neutral-grad-0 px-4 py-3">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-xs font-medium uppercase text-text-on-main-bg-color">
                  {{ t("chatInfo.members") }} ({{ room.members.length }})
                </span>
                <!-- Add member button (admin only) -->
                <button
                  v-if="isAdmin"
                  class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-color-bg-ac transition-colors hover:bg-neutral-grad-0"
                  @click="showAddMember = !showAddMember"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  {{ t("chatInfo.addMember") }}
                </button>
              </div>

              <!-- Add member search (inline) -->
              <div v-if="showAddMember" class="mb-3">
                <input
                  :value="addSearchQuery"
                  type="text"
                  :placeholder="t('info.searchToAdd')"
                  class="mb-2 w-full rounded-lg bg-chat-input-bg px-3 py-2 text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
                  @input="handleAddMemberSearch"
                />
                <div class="max-h-[200px] overflow-y-auto">
                  <div v-if="addIsSearching" class="flex justify-center py-2">
                    <div class="h-5 w-5 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
                  </div>
                  <button
                    v-for="user in addSearchResults"
                    :key="user.address"
                    class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-neutral-grad-0"
                    :disabled="addingMember"
                    @click="handleAddMember(user.address)"
                  >
                    <UserAvatar :address="user.address" size="sm" />
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm text-text-color">{{ user.name }}</div>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-color-bg-ac">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                  <div v-if="addSearchResults.length === 0 && addSearchQuery && !addIsSearching" class="py-2 text-center text-xs text-text-on-main-bg-color">
                    {{ t("info.noUsersFound") }}
                  </div>
                </div>
              </div>

              <!-- Member list -->
              <div class="flex flex-col gap-1">
                <div
                  v-for="member in room.members"
                  :key="member"
                  class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors"
                  :class="isAdmin && member !== myHexId ? 'cursor-pointer hover:bg-neutral-grad-0' : ''"
                  @click="(e: MouseEvent) => openMemberMenu(e, member)"
                >
                  <UserAvatar :address="hexDecode(member)" size="sm" />
                  <span class="min-w-0 flex-1 truncate text-sm text-text-color">
                    {{ chatStore.getDisplayName(member) }}
                  </span>
                  <span
                    v-if="chatStore.isMemberMuted(room.id, member)"
                    class="shrink-0 rounded bg-neutral-grad-2/30 px-1.5 py-0.5 text-[10px] font-medium text-text-on-main-bg-color"
                  >
                    {{ t("info.muted") }}
                  </span>
                  <span
                    v-if="isMemberAdmin(member)"
                    class="shrink-0 rounded bg-color-bg-ac/15 px-1.5 py-0.5 text-[10px] font-medium text-color-bg-ac"
                  >
                    {{ t("info.admin") }}
                  </span>
                </div>
              </div>

              <!-- Banned members (admin only) -->
              <div v-if="isAdmin && bannedMembers.length > 0" class="mt-3">
                <div class="mb-2 text-xs font-medium uppercase text-text-on-main-bg-color">
                  {{ t("info.banned", { count: bannedMembers.length }) }}
                </div>
                <div class="flex flex-col gap-1">
                  <div
                    v-for="banned in bannedMembers"
                    :key="banned.userId"
                    class="flex items-center gap-3 rounded-lg px-2 py-2"
                  >
                    <UserAvatar :address="matrixIdToAddress(banned.userId)" size="sm" />
                    <span class="min-w-0 flex-1 truncate text-sm text-text-on-main-bg-color line-through">
                      {{ banned.name }}
                    </span>
                    <button
                      class="shrink-0 rounded px-2 py-0.5 text-xs text-color-bg-ac hover:bg-neutral-grad-0"
                      :disabled="unbanningUser === banned.userId"
                      @click="handleUnban(banned.userId)"
                    >
                      {{ unbanningUser === banned.userId ? "..." : t("info.unban") }}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Danger zone -->
            <div class="border-t border-neutral-grad-0 px-4 py-3">
              <button
                class="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-sm text-color-bad transition-colors hover:bg-neutral-grad-0"
                @click="confirmAction = 'leave'"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                {{ room.isGroup ? t("chatInfo.leaveGroup") : t("chatInfo.deleteChat") }}
              </button>

              <!-- Delete group button (admin only) -->
              <button
                v-if="room.isGroup && isAdmin"
                class="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-sm text-color-bad transition-colors hover:bg-neutral-grad-0"
                @click="confirmAction = 'delete'"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                {{ t("chatInfo.deleteGroup") }}
              </button>

              <!-- Confirmation dialog -->
              <transition name="panel-fade">
                <div
                  v-if="confirmAction"
                  class="mt-3 rounded-lg border border-color-bad/30 bg-color-bad/5 p-3"
                >
                  <p class="mb-3 text-sm text-text-color">
                    <template v-if="confirmAction === 'delete'">
                      {{ t("chatInfo.confirmDeleteGroup") }}
                    </template>
                    <template v-else-if="confirmAction === 'leave'">
                      {{ t("chatInfo.confirmLeave") }}
                    </template>
                    <template v-else-if="confirmAction === 'clear'">
                      {{ t("chatInfo.confirmClear") }}
                    </template>
                    <template v-else-if="confirmAction === 'block'">
                      {{ t("chatInfo.confirmBlock") }}
                    </template>
                    <template v-else>
                      {{ t("chatInfo.confirmDelete") }}
                    </template>
                  </p>
                  <div class="flex gap-2">
                    <button
                      class="flex-1 rounded-lg bg-neutral-grad-0 px-3 py-2 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
                      @click="confirmAction = null"
                    >
                      {{ t("info.cancel") }}
                    </button>
                    <button
                      class="flex-1 rounded-lg bg-color-bad px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-color-bad/90"
                      @click="confirmAction === 'delete' ? handleDeleteChat() : (confirmAction === 'leave' && room?.isGroup ? handleLeaveGroup() : handleDeleteChat())"
                    >
                      {{ confirmAction === 'delete' ? t("info.delete") : (confirmAction === 'leave' && room.isGroup ? t("info.leave") : t("info.delete")) }}
                    </button>
                  </div>
                </div>
              </transition>
            </div>
          </div>

          <!-- Screen: Gallery -->
          <ChatInfoGallery
            v-else-if="screen === 'gallery'"
            :initial-tab="galleryInitialTab"
            @back="screen = 'main'"
            @go-to-message="(id) => { emit('goToMessage', id); emit('close'); }"
          />
        </div>
      </div>
    </transition>

    <!-- More context menu -->
    <ContextMenu
      :show="showMoreMenu"
      :x="moreMenuPos.x"
      :y="moreMenuPos.y"
      :items="moreMenuItems"
      @close="showMoreMenu = false"
      @select="handleMoreAction"
    />

    <!-- Member action menu (admin) -->
    <transition name="panel-fade">
      <div
        v-if="memberAction.show"
        class="fixed inset-0 z-[60]"
        @click="memberAction.show = false"
      >
        <div
          class="absolute w-52 overflow-hidden rounded-xl border border-neutral-grad-0 bg-background-total-theme shadow-lg"
          :style="memberMenuStyle"
          @click.stop
        >
          <!-- Member info header -->
          <div class="flex items-center gap-3 border-b border-neutral-grad-0 px-4 py-3">
            <UserAvatar :address="hexDecode(memberAction.hexId)" size="sm" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-text-color">
                {{ chatStore.getDisplayName(memberAction.hexId) }}
              </div>
              <span
                v-if="isMemberAdmin(memberAction.hexId)"
                class="text-[10px] font-medium text-color-bg-ac"
              >
                {{ t("info.adminLabel") }}
              </span>
            </div>
          </div>

          <div class="py-1">
            <button
              class="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-text-color hover:bg-neutral-grad-0"
              :disabled="togglingAdmin"
              @click="handleToggleAdmin"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              {{ isMemberAdmin(memberAction.hexId) ? t("info.removeAdmin") : t("info.makeAdmin") }}
            </button>
            <!-- Mute / Unmute -->
            <button
              class="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-text-color hover:bg-neutral-grad-0"
              :disabled="mutingMember"
              @click="handleToggleMute"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path v-if="isActionMemberMuted" d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path v-if="isActionMemberMuted" d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line v-if="!isActionMemberMuted" x1="1" y1="1" x2="23" y2="23" />
                <path v-if="!isActionMemberMuted" d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                <path v-if="!isActionMemberMuted" d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18" />
              </svg>
              {{ isActionMemberMuted ? t("info.unmute") : t("info.muteInChat") }}
            </button>
            <!-- Kick -->
            <button
              class="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-color-bad hover:bg-neutral-grad-0"
              :disabled="kickingMember"
              @click="handleKickMember"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="8.5" cy="7" r="4" />
                <line x1="18" y1="8" x2="23" y2="13" /><line x1="23" y1="8" x2="18" y2="13" />
              </svg>
              {{ t("info.removeFromGroup") }}
            </button>
            <!-- Ban -->
            <button
              class="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-color-bad hover:bg-neutral-grad-0"
              :disabled="banningMember"
              @click="handleBanMember"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
              {{ t("info.banFromGroup") }}
            </button>
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
