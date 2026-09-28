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
const fakeAcceptInvite = vi.hoisted(() => vi.fn(async (_roomId: string) => true));
const fakeToast = vi.hoisted(() => vi.fn());
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
      acceptInvite: fakeAcceptInvite,
      declineInvite: vi.fn(),
      checkPeerKeys: vi.fn(),
      getRoomPowerLevels: vi.fn(() => ({ myLevel: 0 })),
      getTypingUsers: vi.fn(() => []),
      getDisplayName: vi.fn(() => ""),
      getRoomMemberCount: vi.fn(() => 0),
      isRoomPublic: vi.fn(() => false),
    }),
  };
});

// ── Mock auth store ───────────────────────────────────────────────
const fakeAuth = vi.hoisted(() => ({
  address: null,
  pcrypto: null,
  ownKeysMissing: false,
  republishKeysFromUi: vi.fn(async () => ({ state: "republished" })),
}));
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => fakeAuth,
}));

// ── Mock channel store ────────────────────────────────────────────
vi.mock("@/entities/channel", () => ({
  useChannelStore: () => ({
    activeChannelAddress: null,
    clearActiveChannel: vi.fn(),
  }),
}));

// ── Mock ai-chat store — ChatWindow clears it on activeRoomId changes ──
vi.mock("@/entities/ai-chat", () => ({
  useAiChatStore: () => ({
    activeChatId: null,
    selectChat: vi.fn(),
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
  useToast: () => ({ toast: fakeToast }),
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

vi.mock("@/shared/lib/local-db", async () => {
  const actual = await vi.importActual<typeof import("@/shared/lib/local-db")>("@/shared/lib/local-db");
  return {
    ...actual,
    getChatDb: () => ({
      listened: { isListened: vi.fn(() => Promise.resolve(false)) },
      callProviders: { toArray: vi.fn(() => Promise.resolve([])) },
    }),
    isChatDbReady: () => false,
    useLiveQuery: <T>(_query: () => Promise<T[]> | T[] | undefined, _defaultValue?: T[]) => ({
      data: ref([] as T[]),
    }),
  };
});

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
import {
  useCallFeedbackPrompt,
  __resetCallFeedbackPromptForTests,
} from "@/features/video-calls/model/use-call-feedback-prompt";

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

  // Audit S7-03: a group with a member who never published keys can't encrypt,
  // so every send failed after ~31 s of retries — and the banner that explains
  // it was hard-suppressed for groups, leaving everyone guessing.
  it("explains missing member keys in a group instead of hiding the banner", async () => {
    fakeActiveRoomId.value = "!grp:matrix.org";
    fakeRooms.value = [{ id: "!grp:matrix.org", name: "Team", isGroup: true, members: [], membership: "join" }];
    fakeRoomsInitialized.value = true;
    peerKeysStatusMap.set("!grp:matrix.org", "missing");

    const wrapper = mount(ChatWindow, mountOpts);
    await flushPromises();

    expect(wrapper.text()).toContain("chat.groupMemberKeysMissing");
    expect(wrapper.text()).not.toContain("chat.peerKeysMissing");
    wrapper.unmount();
  });

  // Audit W2A-01: when THIS account's keys are missing, the banner blamed the
  // peer and offered no way out; it now says so and offers to publish them.
  it("tells the user their own keys are missing and offers to publish them", async () => {
    fakeAuth.ownKeysMissing = true;
    try {
      fakeActiveRoomId.value = "!dm:matrix.org";
      fakeRooms.value = [{ id: "!dm:matrix.org", name: "Alice", isGroup: false, members: [], membership: "join" }];
      fakeRoomsInitialized.value = true;
      peerKeysStatusMap.set("!dm:matrix.org", "missing");

      const wrapper = mount(ChatWindow, mountOpts);
      await flushPromises();

      expect(wrapper.text()).toContain("chat.ownKeysMissing");
      expect(wrapper.text()).not.toContain("chat.peerKeysMissing");
      const publish = wrapper.findAll("button").find((b) => b.text() === "chat.publishOwnKeys");
      expect(publish).toBeDefined();
      await publish!.trigger("click");
      await flushPromises();
      expect(fakeAuth.republishKeysFromUi).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    } finally {
      fakeAuth.ownKeysMissing = false;
    }
  });

  // Audit S3b-03: a failed join brought the invite screen back with no word.
  it("says so when accepting an invite fails, and stays quiet when it works", async () => {
    fakeActiveRoomId.value = "!inv:matrix.org";
    fakeRooms.value = [{ id: "!inv:matrix.org", name: "Team", isGroup: true, members: [], membership: "invite" }];
    fakeRoomsInitialized.value = true;
    fakeToast.mockClear();

    const wrapper = mount(ChatWindow, mountOpts);
    await flushPromises();
    const accept = wrapper.findAll("button").find((b) => b.text() === "chat.accept");
    expect(accept).toBeDefined();

    fakeAcceptInvite.mockResolvedValueOnce(false);
    await accept!.trigger("click");
    await flushPromises();
    expect(fakeAcceptInvite).toHaveBeenCalledWith("!inv:matrix.org");
    expect(fakeToast).toHaveBeenCalledWith("chat.acceptInviteFailed", "error");

    fakeToast.mockClear();
    fakeAcceptInvite.mockResolvedValueOnce(true);
    await accept!.trigger("click");
    await flushPromises();
    expect(fakeToast).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps the 1:1 wording for a direct chat whose peer has no keys", async () => {
    fakeActiveRoomId.value = "!dm:matrix.org";
    fakeRooms.value = [{ id: "!dm:matrix.org", name: "Alice", isGroup: false, members: [], membership: "join" }];
    fakeRoomsInitialized.value = true;
    peerKeysStatusMap.set("!dm:matrix.org", "missing");

    const wrapper = mount(ChatWindow, mountOpts);
    await flushPromises();

    expect(wrapper.text()).toContain("chat.peerKeysMissing");
    wrapper.unmount();
  });

  it("docks the post-call feedback card in the joined room, not on placeholders", async () => {
    // Deliberately unstubbed: a name-keyed stub resolves even when ChatWindow
    // never imports the component, which is exactly the regression to catch.
    const { show } = useCallFeedbackPrompt();
    show(5);

    fakeActiveRoomId.value = null;
    fakeRoomsInitialized.value = true;

    const empty = mount(ChatWindow, mountOpts);
    await flushPromises();
    expect(empty.find('[data-testid="call-feedback-good"]').exists()).toBe(false);
    empty.unmount();

    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = [
      { id: "!abc:matrix.org", name: "Alice", isGroup: false, members: [], membership: "join" },
    ];

    const joined = mount(ChatWindow, mountOpts);
    await flushPromises();
    expect(joined.find('[data-testid="call-feedback-good"]').exists()).toBe(true);
    joined.unmount();

    __resetCallFeedbackPromptForTests();
  });
});
