import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { computed, ref } from "vue";

// ── Force mobile viewport before Vue mounts ──────────────────────
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    value: 500,
    configurable: true,
    writable: true,
  });
});

// ── Mock the chat store (setup store with reactive activeRoomId/rooms) ─
interface FakeRoom {
  id: string;
  name: string;
}

const fakeActiveRoomId = ref<string | null>(null);
const fakeRooms = ref<FakeRoom[]>([]);
const fakeRoomsInitialized = ref(false);

const fakeActiveRoom = computed(() => {
  const id = fakeActiveRoomId.value;
  if (!id) return undefined;
  return fakeRooms.value.find((r) => r.id === id);
});

const setActiveRoomSpy = vi.fn((roomId: string | null) => {
  fakeActiveRoomId.value = roomId;
});

vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({
    get activeRoomId() {
      return fakeActiveRoomId.value;
    },
    set activeRoomId(v: string | null) {
      fakeActiveRoomId.value = v;
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
    setActiveRoom: setActiveRoomSpy,
  }),
}));

// ── Mock channel store — ChatPage must react to activeChannelAddress ───
const fakeActiveChannelAddress = ref<string | null>(null);
const clearActiveChannelSpy = vi.fn(() => {
  fakeActiveChannelAddress.value = null;
});

vi.mock("@/entities/channel", () => ({
  useChannelStore: () => ({
    get activeChannelAddress() {
      return fakeActiveChannelAddress.value;
    },
    clearActiveChannel: clearActiveChannelSpy,
  }),
}));

// ── Mock auth store (ChatPage only reads from it) ─────────────────
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    user: ref(null),
    matrixReady: ref(true),
  }),
}));

// ── Mock i18n, sidebar-tab, android back handler, audio playback ──
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

const closeSettingsContentSpy = vi.fn();
const setTabSpy = vi.fn();
const settingsSubViewRef = ref<string | null>(null);

vi.mock("@/widgets/sidebar/model/use-sidebar-tab", () => ({
  useSidebarTab: () => ({
    settingsSubView: settingsSubViewRef,
    closeSettingsContent: closeSettingsContentSpy,
    setTab: setTabSpy,
    activeTab: ref("chats"),
    openSettingsContent: vi.fn(),
  }),
}));

vi.mock("@/shared/lib/composables/use-android-back-handler", () => ({
  useAndroidBackHandler: vi.fn(),
}));

vi.mock("@/features/messaging/model/use-audio-playback", () => ({
  useAudioPlayback: () => ({
    stop: vi.fn(),
    play: vi.fn(),
  }),
}));

// ── Now import the SFC AFTER mocks are set up ─────────────────────
import ChatPage from "../ChatPage.vue";

// Stub <transition> to a pass-through so v-show display:none is applied
// synchronously — jsdom/happy-dom don't fire transitionend, so the real
// Transition component leaves elements visually visible indefinitely.
const TransitionStub = {
  name: "Transition",
  render(this: { $slots: { default?: () => unknown } }) {
    return this.$slots?.default?.();
  },
};

// ── Stubs for child components that ChatPage renders ──────────────
const mountOpts = {
  global: {
    stubs: {
      ChatSidebar: {
        name: "ChatSidebar",
        template: '<div data-testid="chat-sidebar" />',
      },
      ChatWindow: {
        name: "ChatWindow",
        template: '<div data-testid="chat-window" />',
      },
      SettingsContentPanel: {
        name: "SettingsContentPanel",
        template: '<div data-testid="settings-content" />',
      },
      GroupCreationPanel: {
        name: "GroupCreationPanel",
        template: '<div data-testid="group-creation" />',
      },
      Transition: TransitionStub,
      transition: TransitionStub,
    },
  },
};

beforeEach(() => {
  fakeActiveRoomId.value = null;
  fakeRooms.value = [];
  fakeRoomsInitialized.value = false;
  fakeActiveChannelAddress.value = null;
  settingsSubViewRef.value = null;
  setActiveRoomSpy.mockClear();
  closeSettingsContentSpy.mockClear();
  setTabSpy.mockClear();
  clearActiveChannelSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Helper — returns true only if element is in DOM AND not v-show-hidden.
const isVisible = (el: HTMLElement | null | undefined): boolean => {
  if (!el) return false;
  // v-show="false" sets inline display: none
  return el.style.display !== "none";
};

describe("ChatPage — reactive showSidebar", () => {
  it("hides sidebar on mobile as soon as activeRoomId is set, even before the room object hydrates", async () => {
    // Push-intent / cold-start: activeRoomId restored before Matrix sync
    // resolves `rooms`. Before the fix, this kept sidebar on top and the
    // MessageSkeleton inside ChatWindow was never visible.
    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = []; // room object not available yet
    fakeRoomsInitialized.value = false;

    const wrapper = mount(ChatPage, mountOpts);
    await flushPromises();

    const sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(sidebar.exists()).toBe(true);
    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);

    // ChatWindow owns the loading placeholder (MessageSkeleton); must be shown.
    const chatWindow = wrapper.find('[data-testid="chat-window"]');
    expect(chatWindow.exists()).toBe(true);
    expect(isVisible(chatWindow.element as HTMLElement)).toBe(true);

    wrapper.unmount();
  });

  it("keeps ChatWindow visible after activeRoom finishes hydrating", async () => {
    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = [];
    fakeRoomsInitialized.value = false;

    const wrapper = mount(ChatPage, mountOpts);
    await flushPromises();

    const sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);

    fakeRooms.value = [{ id: "!abc:matrix.org", name: "Test Room" }];
    fakeRoomsInitialized.value = true;
    await flushPromises();

    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);
    const chatWindow = wrapper.find('[data-testid="chat-window"]');
    expect(chatWindow.exists()).toBe(true);
    expect(isVisible(chatWindow.element as HTMLElement)).toBe(true);

    wrapper.unmount();
  });

  it("hides sidebar on mobile when a channel becomes active (no activeRoomId)", async () => {
    // Regression: before the fix, opening a channel set
    // channelStore.activeChannelAddress but ChatPage only watched
    // chatStore.activeRoom, so sidebar stayed on top and ChannelView
    // (rendered inside ChatWindow) was never visible.
    fakeActiveRoomId.value = null;
    fakeActiveChannelAddress.value = "PEUYuN8J1...";

    const wrapper = mount(ChatPage, mountOpts);
    await flushPromises();

    const sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(sidebar.exists()).toBe(true);
    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);

    const chatWindow = wrapper.find('[data-testid="chat-window"]');
    expect(chatWindow.exists()).toBe(true);
    expect(isVisible(chatWindow.element as HTMLElement)).toBe(true);

    wrapper.unmount();
  });

  it("hides sidebar when a channel becomes active after mount", async () => {
    // Start on sidebar (no active room, no active channel)
    const wrapper = mount(ChatPage, mountOpts);
    await flushPromises();

    const sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(true);

    // Simulate user tapping a channel — channel store becomes active
    fakeActiveChannelAddress.value = "PEUYuN8J1...";
    await flushPromises();

    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);
    const chatWindow = wrapper.find('[data-testid="chat-window"]');
    expect(isVisible(chatWindow.element as HTMLElement)).toBe(true);

    wrapper.unmount();
  });

  it("shows sidebar when user manually backs out to list", async () => {
    // Start inside a chat with room loaded
    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = [{ id: "!abc:matrix.org", name: "Test Room" }];
    fakeRoomsInitialized.value = true;

    const wrapper = mount(ChatPage, mountOpts);
    await flushPromises();

    // Sidebar starts hidden (chat view is active)
    let sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);

    // Simulate user pressing back button in ChatWindow
    const chatWindow = wrapper.findComponent({ name: "ChatWindow" });
    expect(chatWindow.exists()).toBe(true);
    chatWindow.vm.$emit("back");
    await flushPromises();

    // activeRoomId should be cleared; also clears any active channel
    expect(setActiveRoomSpy).toHaveBeenCalledWith(null);
    expect(fakeActiveRoomId.value).toBeNull();
    expect(clearActiveChannelSpy).toHaveBeenCalled();

    // Sidebar should now be visible
    sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(sidebar.exists()).toBe(true);
    expect(isVisible(sidebar.element as HTMLElement)).toBe(true);

    wrapper.unmount();
  });

  it("keeps sidebar visible on desktop regardless of activeRoom state", async () => {
    // Override default mobile viewport for this test only — isMobile samples
    // window.innerWidth synchronously at setup time.
    Object.defineProperty(window, "innerWidth", {
      value: 1200,
      configurable: true,
      writable: true,
    });

    // Even with activeRoom fully loaded, desktop shows sidebar + chat pane
    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = [{ id: "!abc:matrix.org", name: "Test Room" }];
    fakeRoomsInitialized.value = true;

    const wrapper = mount(ChatPage, mountOpts);
    await flushPromises();

    // On desktop the <template v-if="!isMobile"> branch renders ChatSidebar
    // and ChatWindow side-by-side; both must be present and visible.
    const sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(sidebar.exists()).toBe(true);
    expect(isVisible(sidebar.element as HTMLElement)).toBe(true);

    const chatWindow = wrapper.find('[data-testid="chat-window"]');
    expect(chatWindow.exists()).toBe(true);
    expect(isVisible(chatWindow.element as HTMLElement)).toBe(true);

    wrapper.unmount();
  });

  it("resets userForcedSidebar when external push sets a new activeRoomId", async () => {
    // Start mobile, inside a fully loaded room
    fakeActiveRoomId.value = "!first:matrix.org";
    fakeRooms.value = [{ id: "!first:matrix.org", name: "First Room" }];
    fakeRoomsInitialized.value = true;

    const wrapper = mount(ChatPage, mountOpts);
    await flushPromises();

    // User backs out — userForcedSidebar becomes true internally, activeRoomId null
    const chatWindow = wrapper.findComponent({ name: "ChatWindow" });
    expect(chatWindow.exists()).toBe(true);
    chatWindow.vm.$emit("back");
    await flushPromises();

    let sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(true);

    // External push intent arrives — even before rooms[] contains the target,
    // ChatWindow must become visible (it will render MessageSkeleton while the
    // room hydrates). Without resetting userForcedSidebar, sidebar would stay
    // stuck on top.
    fakeActiveRoomId.value = "!second:matrix.org";
    await flushPromises();

    sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);
    const chatWindowAfter = wrapper.find('[data-testid="chat-window"]');
    expect(isVisible(chatWindowAfter.element as HTMLElement)).toBe(true);

    // Room materialises — ChatWindow remains visible (now with real content)
    fakeRooms.value = [
      ...fakeRooms.value,
      { id: "!second:matrix.org", name: "Second Room" },
    ];
    await flushPromises();

    expect(isVisible(chatWindowAfter.element as HTMLElement)).toBe(true);
    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);

    wrapper.unmount();
  });

  it("resets userForcedSidebar when an external channel-open occurs", async () => {
    // Mount on sidebar, user-forced (nothing active yet)
    const wrapper = mount(ChatPage, mountOpts);
    await flushPromises();

    // Force sidebar state by invoking back (userForcedSidebar → true)
    // Then an external actor activates a channel — sidebar must hide.
    fakeActiveChannelAddress.value = null;
    // simulate a prior back press by directly tripping the forced-state:
    // easiest path is the real back emit after a brief activeRoomId flash.
    fakeActiveRoomId.value = "!temp:matrix.org";
    fakeRooms.value = [{ id: "!temp:matrix.org", name: "Temp" }];
    fakeRoomsInitialized.value = true;
    await flushPromises();

    const chatWindow = wrapper.findComponent({ name: "ChatWindow" });
    chatWindow.vm.$emit("back");
    await flushPromises();

    let sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(true);

    // External channel activation (e.g. deep link)
    fakeActiveChannelAddress.value = "PEUYuN8J1...";
    await flushPromises();

    sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);
    const cw = wrapper.find('[data-testid="chat-window"]');
    expect(isVisible(cw.element as HTMLElement)).toBe(true);

    wrapper.unmount();
  });
});
