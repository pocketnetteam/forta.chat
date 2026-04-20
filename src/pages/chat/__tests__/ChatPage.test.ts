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
  settingsSubViewRef.value = null;
  setActiveRoomSpy.mockClear();
  closeSettingsContentSpy.mockClear();
  setTabSpy.mockClear();
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
  it("shows sidebar on mobile when activeRoomId is set but activeRoom is not loaded", async () => {
    // Simulate push-intent restoration: activeRoomId set before rooms sync
    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = []; // room object not available yet
    fakeRoomsInitialized.value = false;

    const wrapper = mount(ChatPage, mountOpts);
    await flushPromises();

    const sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(sidebar.exists()).toBe(true);
    // Must be visible (not hidden by v-show="false")
    expect(isVisible(sidebar.element as HTMLElement)).toBe(true);

    // ChatWindow should NOT be visible — we're still on the list
    const chatWindow = wrapper.find('[data-testid="chat-window"]');
    expect(isVisible(chatWindow.element as HTMLElement)).toBe(false);

    wrapper.unmount();
  });

  it("hides sidebar on mobile when activeRoom becomes available", async () => {
    // Start with push-intent state: id present, room object not yet loaded
    fakeActiveRoomId.value = "!abc:matrix.org";
    fakeRooms.value = [];
    fakeRoomsInitialized.value = false;

    const wrapper = mount(ChatPage, mountOpts);
    await flushPromises();

    // Initially sidebar must be visible because activeRoom is unresolved
    const sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(true);

    // Now rooms finish syncing and the target room appears
    fakeRooms.value = [{ id: "!abc:matrix.org", name: "Test Room" }];
    fakeRoomsInitialized.value = true;
    await flushPromises();

    // Sidebar should now hide and chat window should be visible
    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);
    const chatWindow = wrapper.find('[data-testid="chat-window"]');
    expect(chatWindow.exists()).toBe(true);
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

    // activeRoomId should be null
    expect(setActiveRoomSpy).toHaveBeenCalledWith(null);
    expect(fakeActiveRoomId.value).toBeNull();

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

    // User backs out to sidebar — userForcedSidebar becomes true internally
    const chatWindow = wrapper.findComponent({ name: "ChatWindow" });
    expect(chatWindow.exists()).toBe(true);
    chatWindow.vm.$emit("back");
    await flushPromises();

    let sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(true);

    // External push intent: a new activeRoomId arrives while rooms[] doesn't
    // yet contain the target room. Without the new watcher, userForcedSidebar
    // would stay true and sidebar would remain stuck visible even after the
    // room materialises below.
    fakeActiveRoomId.value = "!second:matrix.org";
    await flushPromises();

    // Sidebar still visible because activeRoom is undefined (room not in list)
    sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(true);

    // Now the second room materialises in rooms[] — this is the verification:
    // if userForcedSidebar had stayed true, sidebar would stay visible. With
    // the watcher reset, showSidebar falls back to !activeRoom and hides.
    fakeRooms.value = [
      ...fakeRooms.value,
      { id: "!second:matrix.org", name: "Second Room" },
    ];
    await flushPromises();

    sidebar = wrapper.find('[data-testid="chat-sidebar"]');
    expect(isVisible(sidebar.element as HTMLElement)).toBe(false);

    const chatWindowAfter = wrapper.find('[data-testid="chat-window"]');
    expect(isVisible(chatWindowAfter.element as HTMLElement)).toBe(true);

    wrapper.unmount();
  });
});
