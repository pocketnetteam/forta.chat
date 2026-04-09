<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { MessageType } from "@/entities/chat/model/types";
import type { Message } from "@/entities/chat/model/types";
import type { TranslationKey } from "@/shared/lib/i18n";
import { ContextMenu } from "@/shared/ui/context-menu";
import type { ContextMenuItem } from "@/shared/ui/context-menu";
import MediaViewer from "@/features/messaging/ui/MediaViewer.vue";
import MediaGrid from "./MediaGrid.vue";
import FilesList from "./FilesList.vue";
import LinksList from "./LinksList.vue";
import VoiceList from "./VoiceList.vue";

const props = withDefaults(
  defineProps<{
    initialTab?: "media" | "files" | "links" | "voice";
  }>(),
  { initialTab: "media" },
);

const emit = defineEmits<{
  back: [];
  goToMessage: [messageId: string];
}>();

const { t } = useI18n();
const chatStore = useChatStore();
const authStore = useAuthStore();

type TabId = "media" | "files" | "links" | "voice";
const activeTab = ref<TabId>(props.initialTab);

const tabs: { id: TabId; labelKey: TranslationKey }[] = [
  { id: "media", labelKey: "chatInfo.media" },
  { id: "files", labelKey: "chatInfo.files" },
  { id: "links", labelKey: "chatInfo.links" },
  { id: "voice", labelKey: "chatInfo.voice" },
];

// Load all messages on mount (like search does)
const loadingAll = ref(false);
const allLoaded = ref(false);

onMounted(async () => {
  const roomId = chatStore.activeRoomId;
  if (roomId && !allLoaded.value) {
    loadingAll.value = true;
    await chatStore.loadAllMessages(roomId);
    allLoaded.value = true;
    loadingAll.value = false;
  }
});

// Filtered message arrays
const mediaMessages = computed(() =>
  chatStore.activeMessages.filter(
    (m) => m.type === MessageType.image || m.type === MessageType.video,
  ),
);
const fileMessages = computed(() =>
  chatStore.activeMessages.filter((m) => m.type === MessageType.file),
);
const voiceMessages = computed(() =>
  chatStore.activeMessages.filter((m) => m.type === MessageType.audio),
);
const textMessages = computed(() =>
  chatStore.activeMessages.filter((m) => m.type === MessageType.text),
);

// MediaViewer state
const showViewer = ref(false);
const viewerMessageId = ref<string | null>(null);

const openViewer = (messageId: string) => {
  viewerMessageId.value = messageId;
  showViewer.value = true;
};

// ── Context menu ──
const ctxMenu = ref({ show: false, x: 0, y: 0 });
const ctxMessage = ref<Message | null>(null);

const svg = (d: string) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  forward: svg('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>'),
  goTo:    svg('<polyline points="9 17 4 12 9 7"/><line x1="4" y1="12" x2="20" y2="12"/>'),
  delete:  svg('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
};

const ctxMenuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = [
    { label: t("chatInfo.forward"), icon: ICONS.forward, action: "forward" },
    { label: t("chatInfo.goToMessage"), icon: ICONS.goTo, action: "goToMessage" },
  ];
  if (ctxMessage.value && ctxMessage.value.senderId === authStore.address) {
    items.push({ label: t("chatInfo.delete"), icon: ICONS.delete, action: "delete", danger: true });
  }
  return items;
});

/** Called by MediaGrid / FilesList / VoiceList (emit message object) */
const handleContextMenu = (payload: { message: Message; x: number; y: number }) => {
  ctxMessage.value = payload.message;
  ctxMenu.value = { show: true, x: payload.x, y: payload.y };
};

/** Called by LinksList (emits messageId string) */
const handleLinksContextMenu = (payload: { messageId: string; x: number; y: number }) => {
  const msg = chatStore.activeMessages.find((m) => m.id === payload.messageId);
  if (!msg) return;
  ctxMessage.value = msg;
  ctxMenu.value = { show: true, x: payload.x, y: payload.y };
};

const closeCtxMenu = () => {
  ctxMenu.value.show = false;
};

const handleCtxAction = (action: string) => {
  const msg = ctxMessage.value;
  if (!msg) return;

  switch (action) {
    case "forward":
      chatStore.initForward(msg);
      break;
    case "goToMessage":
      emit("goToMessage", msg.id);
      break;
    case "delete":
      chatStore.deletingMessage = msg;
      break;
  }

  closeCtxMenu();
};

// Tab underline position (for sliding animation)
const tabRefs = ref<HTMLElement[]>([]);
const underlineStyle = computed(() => {
  const idx = tabs.findIndex((tab) => tab.id === activeTab.value);
  if (idx < 0 || !tabRefs.value[idx]) return {};
  const el = tabRefs.value[idx];
  return {
    width: `${el.offsetWidth}px`,
    transform: `translateX(${el.offsetLeft}px)`,
  };
});
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div
      class="flex items-center gap-2 border-b border-neutral-grad-0 px-2 py-3"
    >
      <button
        class="flex h-8 w-8 items-center justify-center rounded-full text-text-color transition-colors hover:bg-neutral-grad-0"
        @click="emit('back')"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <span class="text-base font-semibold text-text-color">{{
        t("chatInfo.mediaAndFiles")
      }}</span>
    </div>

    <!-- Tabs -->
    <div class="relative flex border-b border-neutral-grad-0">
      <button
        v-for="(tab, i) in tabs"
        :key="tab.id"
        :ref="
          (el) => {
            if (el) tabRefs[i] = el as HTMLElement;
          }
        "
        class="flex-1 py-2.5 text-center text-[13px] font-medium transition-colors"
        :class="
          activeTab === tab.id
            ? 'text-color-bg-ac'
            : 'text-text-on-main-bg-color hover:text-text-color'
        "
        @click="activeTab = tab.id"
      >
        {{ t(tab.labelKey) }}
      </button>
      <!-- Sliding underline -->
      <div
        class="absolute bottom-0 h-0.5 bg-color-bg-ac transition-all duration-200 ease-in-out"
        :style="underlineStyle"
      />
    </div>

    <!-- Tab content (scrollable) -->
    <div class="flex-1 overflow-y-auto">
      <!-- Loading indicator while fetching all messages -->
      <div v-if="loadingAll" class="flex flex-col items-center justify-center py-16">
        <div class="h-6 w-6 animate-spin rounded-full border-2 border-neutral-grad-0 border-t-color-bg-ac" />
        <span class="mt-3 text-sm text-text-on-main-bg-color">{{ t("chatInfo.loadingMessages") }}</span>
      </div>

      <template v-else>
      <MediaGrid
        v-if="activeTab === 'media'"
        :messages="mediaMessages"
        @select="openViewer"
        @contextmenu="handleContextMenu"
      />
      <FilesList
        v-else-if="activeTab === 'files'"
        :messages="fileMessages"
        @contextmenu="handleContextMenu"
      />
      <LinksList
        v-else-if="activeTab === 'links'"
        :messages="textMessages"
        @contextmenu="handleLinksContextMenu"
      />
      <VoiceList
        v-else-if="activeTab === 'voice'"
        :messages="voiceMessages"
        @contextmenu="handleContextMenu"
      />
      </template>
    </div>
  </div>

  <!-- MediaViewer teleported to body -->
  <MediaViewer
    :show="showViewer"
    :message-id="viewerMessageId"
    @close="showViewer = false"
  />

  <!-- Context menu -->
  <ContextMenu
    :show="ctxMenu.show"
    :x="ctxMenu.x"
    :y="ctxMenu.y"
    :items="ctxMenuItems"
    @close="closeCtxMenu"
    @select="handleCtxAction"
  />
</template>
