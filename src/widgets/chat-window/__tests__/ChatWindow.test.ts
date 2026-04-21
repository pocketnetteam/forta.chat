import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { computed, ref } from "vue";

// ── Mock the chat store ───────────────────────────────────────────
interface FakeRoom {
  id: string;
  name: string;
  isGroup?: boolean;
  avatar?: string | null;
  members?: string[];
  membership?: string;
}

const fakeActiveRoomId = ref<string | null>(null);
const fakeRooms = ref<FakeRoom[]>([]);
const fakeRoomsInitialized = ref(false);

const fakeActiveRoom = computed(() => {
  const id = fakeActiveRoomId.value;
  if (!id) return undefined;
  return fakeRooms.value.find((r) => r.id === id);
});

const peerKeysStatusMap = new Map<string, string>();
const activeMessagesRef = ref<unknown[]>([]);
const selectedMessageIdsRef = ref<Set<string>>(new Set());

vi.mock("@/entities/chat", async () => {
  // Need MessageType enum since ChatWindow imports it for playback handler.
  const actual = await vi.importActual<typeof import("@/entities/chat")>("@/entities/chat");
  return {
    ...actual,
    useChatStore: () => ({
      get activeRoomId() {
        return fakeActiveRoomId.value;
      },
      get activeRoom() {
        return fakeActiveRoom.value;
      },
      get rooms() {
        return fakeRooms.value;
      },
      get roomsInitialized() {
        return fakeRoomsInitialized.value;
      },
      get activeMessages() {
        return activeMessagesRef.value;
      },
      get selectedMessageIds() {
        return selectedMessageIdsRef.value;
      },
      get peerKeysStatus() {
        return peerKeysStatusMap;
      },
      selectionMode: false,
      forwardPickerRequested: false,
      deletingMessage: null,
      setActiveRoom: vi.fn(),
      cancelForward: vi.fn(),
      exitSelectionMode: vi.fn(),
      acceptInvite: vi.fn(),
      declineInvite: vi.fn(),
      checkPeerKeys: vi.fn(),
      getRoomPowerLevels: vi.fn(() => ({ myLevel: 0 })),
      getTypingUsers: vi.fn(() => []),
      getDisplayName: vi.fn(() => ""),
      getRoomMemberCount: vi.fn(() => 0),
    }),
  };
});

// ── Mock auth store ───────────────────────────────────────────────
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    address: null,
    pcrypto: null,
  }),
}));

// ── Mock channel store ────────────────────────────────────────────
vi.mock("@/entities/channel", () => ({
  useChannelStore: () => ({
    activeChannelAddress: null,
    clearActiveChannel: vi.fn(),
  }),
}));

// ── Mock user store ───────────────────────────────────────────────
vi.mock("@/entities/user/model", () => ({
  useUserStore: () => ({
    loadUserIfMissing: vi.fn(),
  }),
}));

// ── Mock i18n (auto-imported) ─────────────────────────────────────
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// ── Mock audio/file/call/wallet/toast/paste-drop composables ──────
vi.mock("@/features/messaging/model/use-audio-playback", () => ({
  useAudioPlayback: () => ({
    setOnEnded: vi.fn(),
    currentRoomId: ref(null),
    stop: vi.fn(),
    play: vi.fn(),
  }),
}));

vi.mock("@/features/messaging/model/use-file-download", () => ({
  useFileDownload: () => ({
    getState: vi.fn(() => ({ objectUrl: null })),
    download: vi.fn(),
  }),
}));

vi.mock("@/features/video-calls/model/call-service", () => ({
  useCallService: () => ({
    startCall: vi.fn(),
  }),
}));

vi.mock("@/features/wallet", () => ({
  useWalletStore: () => ({
    isAvailable: false,
  }),
}));

vi.mock("@/shared/lib/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/features/messaging/model/use-paste-drop", () => ({
  usePasteDrop: () => ({
    isDragging: ref(false),
    setupDragListeners: vi.fn(),
    handlePaste: vi.fn(),
  }),
}));

vi.mock("@/shared/lib/composables/use-android-back-handler", () => ({
  useAndroidBackHandler: vi.fn(),
}));

vi.mock("@/entities/chat/lib/use-resolved-room-name", () => ({
  useResolvedRoomName: () => ({
    resolve: vi.fn(() => ({ state: "ready", text: "" })),
  }),
}));

vi.mock("@/shared/lib/local-db", () => ({
  getChatDb: () => ({
    listened: { isListened: vi.fn(() => Promise.resolve(false)) },
  }),
}));

vi.mock("@/shared/lib/matrix/functions", () => ({
  hexEncode: (s: string) => s,
  hexDecode: (s: string) => s,
}));

// ── Now import SFC after mocks are set up ─────────────────────────
import ChatWindow from "../ChatWindow.vue";

// Stub <transition> to a pass-through so v-show display:none applied synchronously.
const TransitionStub = {
  name: "Transition",
  render(this: { $slots: { default?: () => unknown } }) {
    return this.$slots?.default?.();
  },
};

// ── Stubs for child components ChatWindow renders ─────────────────
const mountOpts = {
  global: {
    stubs: {
      ChannelView: { name: "ChannelView", template: "<div />" },
      MessageList: { name: "MessageList", template: "<div />" },
      MessageInput: { name: "MessageInput", template: "<div />" },
      SelectionBar: { name: "SelectionBar", template: "<div />" },
      ForwardPicker: { name: "ForwardPicker", template: "<div />" },
      ChatSearch: { name: "ChatSearch", template: "<div />" },
      ChatInfoPanel: { name: "ChatInfoPanel", template: "<div />" },
      UserProfilePanel: { name: "UserProfilePanel", template: "<div />" },
      PinnedBar: { name: "PinnedBar", template: "<div />" },
      UserAvatar: { name: "UserAvatar", template: "<div />" },
      Avatar: { name: "Avatar", template: "<div />" },
      DonateModal: { name: "DonateModal", template: "<div />" },
      DropOverlay: { name: "DropOverlay", template: "<div />" },
      MessageSkeleton: { name: "MessageSkeleton", template: '<div data-testid="message-skeleton" />' },
      Transition: TransitionStub,
      transition: TransitionStub,
    },
  },
};

beforeEach(() => {
  fakeActiveRoomId.value = null;
  fakeRooms.value = [];
  fakeRoomsInitialized.value = false;
  activeMessagesRef.value = [];
  selectedMessageIdsRef.value = new Set();
  peerKeysStatusMap.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ChatWindow — loading vs select-prompt placeholders", () => {
  it("shows loading placeholder when activeRoomId is set but room not yet loaded and rooms are still initializing", async () => {
    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = [];
    fakeRoomsInitialized.value = false;

    const wrapper = mount(ChatWindow, mountOpts);
    await flushPromises();

    const loading = wrapper.find('[data-testid="chat-loading"]');
    expect(loading.exists()).toBe(true);

    const selectPrompt = wrapper.find('[data-testid="chat-select-prompt"]');
    expect(selectPrompt.exists()).toBe(false);

    wrapper.unmount();
  });

  it("shows select-prompt placeholder when no room is selected and rooms are initialized", async () => {
    fakeActiveRoomId.value = null;
    fakeRoomsInitialized.value = true;

    const wrapper = mount(ChatWindow, mountOpts);
    await flushPromises();

    const selectPrompt = wrapper.find('[data-testid="chat-select-prompt"]');
    expect(selectPrompt.exists()).toBe(true);

    const loading = wrapper.find('[data-testid="chat-loading"]');
    expect(loading.exists()).toBe(false);

    wrapper.unmount();
  });

  it("shows select-prompt placeholder when activeRoomId points to a missing (zombie) room but rooms are initialized", async () => {
    // After rooms initialized, the selfHealZombieRoom logic takes over — UI just
    // shows the empty state while the zombie gets cleared.
    fakeActiveRoomId.value = "!dead:matrix.org";
    fakeRooms.value = [];
    fakeRoomsInitialized.value = true;

    const wrapper = mount(ChatWindow, mountOpts);
    await flushPromises();

    const selectPrompt = wrapper.find('[data-testid="chat-select-prompt"]');
    expect(selectPrompt.exists()).toBe(true);

    const loading = wrapper.find('[data-testid="chat-loading"]');
    expect(loading.exists()).toBe(false);

    wrapper.unmount();
  });

  it("renders chat header with back button while room is loading so mobile users can exit cold-load state", async () => {
    // Bug: on mobile during initial Matrix sync, activeRoomId is set but
    // activeRoom is undefined. The header's v-if required activeRoom, so
    // MessageSkeleton occupied the full screen with no header and no way back.
    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = [];
    fakeRoomsInitialized.value = false;

    const wrapper = mount(ChatWindow, mountOpts);
    await flushPromises();

    const header = wrapper.find('[data-testid="chat-header"]');
    expect(header.exists()).toBe(true);

    const backBtn = header.find('[aria-label="nav.back"]');
    expect(backBtn.exists()).toBe(true);

    // Skeleton block still renders below the header.
    const skeleton = wrapper.find('[data-testid="chat-loading"]');
    expect(skeleton.exists()).toBe(true);

    wrapper.unmount();
  });

  it("hides action buttons (call/search/info) in header while room is loading because they depend on room data", async () => {
    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = [];
    fakeRoomsInitialized.value = false;

    const wrapper = mount(ChatWindow, mountOpts);
    await flushPromises();

    const header = wrapper.find('[data-testid="chat-header"]');
    expect(header.find('[aria-label="chat.search"]').exists()).toBe(false);
    expect(header.find('[aria-label="call.voiceCall"]').exists()).toBe(false);
    expect(header.find('[aria-label="info.title"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("push cold-start: shows header+skeleton (not 'select a chat') when deep link sets activeRoomId before Matrix init", async () => {
    // Scenario: user taps a push notification on a cold app. The deep link sets
    // activeRoomId before Matrix has even started syncing. Previously the
    // header's v-if required activeRoom, and isEmptyState would kick in before
    // isRoomLoading had all three conditions, leaving the user on a
    // "select a chat" screen — extra confusing when they just tapped a push.
    fakeActiveRoomId.value = "!pushed:matrix.org";
    fakeRooms.value = []; // Matrix hasn't synced yet
    fakeRoomsInitialized.value = false; // init in-flight

    const wrapper = mount(ChatWindow, mountOpts);
    await flushPromises();

    // Header is visible so user sees a back button and "chat loading" chrome.
    const header = wrapper.find('[data-testid="chat-header"]');
    expect(header.exists()).toBe(true);
    expect(header.find('[aria-label="nav.back"]').exists()).toBe(true);

    // Loading body is rendered, not the empty "select a chat" prompt.
    expect(wrapper.find('[data-testid="chat-loading"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="chat-select-prompt"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("renders full header with avatar/title/actions once room hydrates", async () => {
    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = [
      { id: "!abc:matrix.org", name: "Alice", isGroup: false, members: [], membership: "join" },
    ];
    fakeRoomsInitialized.value = true;

    const wrapper = mount(ChatWindow, mountOpts);
    await flushPromises();

    const header = wrapper.find('[data-testid="chat-header"]');
    expect(header.exists()).toBe(true);
    expect(header.find('[aria-label="nav.back"]').exists()).toBe(true);
    expect(header.find('[aria-label="chat.search"]').exists()).toBe(true);
    expect(header.find('[aria-label="info.title"]').exists()).toBe(true);

    wrapper.unmount();
  });
});
