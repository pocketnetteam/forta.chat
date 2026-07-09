/**
 * Regression: sidebar "blind zone" when channels hydrate before Matrix rooms.
 * ContactList must show loading or stuck UI — never a blank panel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { createTestingPinia } from "@pinia/testing";

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: { value: "en" } }),
}));

vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: {
    name: "RecycleScroller",
    template: "<div><slot /></div>",
  },
}));

vi.mock("@/shared/ui/skeleton", () => ({
  RoomListSkeleton: {
    name: "RoomListSkeleton",
    props: ["firstLoad", "slow"],
    template: "<div data-testid='room-list-skeleton'>{{ slow ? 'slow' : 'loading' }}</div>",
  },
}));

const mockSortedRooms = ref<unknown[]>([]);
const mockIsRoomListLoading = ref(false);
const mockIsRoomListLoadingSlow = ref(false);
const mockIsRoomListStuck = ref(false);
const mockIsRoomListAuthoritativeEmpty = ref(false);
const mockMatrixReady = ref(true);

vi.mock("@/entities/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/entities/chat")>();
  return {
    ...actual,
    useChatStore: () => ({
      get sortedRooms() { return mockSortedRooms.value; },
      get isRoomListLoading() { return mockIsRoomListLoading.value; },
      get isRoomListLoadingSlow() { return mockIsRoomListLoadingSlow.value; },
      get isRoomListStuck() { return mockIsRoomListStuck.value; },
      get isRoomListAuthoritativeEmpty() { return mockIsRoomListAuthoritativeEmpty.value; },
      rooms: [],
      dexieRoomMap: new Map(),
      localAliases: {},
      pinnedRoomIds: new Set(),
      mutedRoomIds: new Set(),
      activeRoomId: null,
      getDisplayName: vi.fn(() => "?"),
      getLocalAlias: vi.fn(() => undefined),
      hasLocalAlias: vi.fn(() => false),
      loadProfilesForRoomIds: vi.fn(),
      loadMembersForRooms: vi.fn(),
      clearProfileCache: vi.fn(),
      setActiveRoom: vi.fn(),
      refreshRoomsNow: vi.fn(),
      refreshRooms: vi.fn(),
      roomFetchStates: new Map(),
      retryRoomFetch: vi.fn(),
    }),
  };
});

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    address: "testaddr",
    get matrixReady() { return mockMatrixReady.value; },
  }),
}));

vi.mock("@/entities/channel", () => ({
  useChannelStore: () => ({
    channels: [{ address: "ch1", name: "Channel", avatar: "" }],
    clearActiveChannel: vi.fn(),
  }),
}));

vi.mock("@/entities/user/model", () => ({
  useUserStore: () => ({
    users: {},
    getUser: vi.fn(),
    enqueueProfiles: vi.fn(),
  }),
}));

vi.mock("@/features/selection", () => ({
  useSelectionStore: () => ({
    isSelectionMode: false,
    isSelected: vi.fn(() => false),
    toggle: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
    count: 0,
  }),
}));

import ContactList from "../ContactList.vue";

describe("ContactList — sidebar blind zone regression", () => {
  beforeEach(() => {
    mockSortedRooms.value = [];
    mockIsRoomListLoading.value = false;
    mockIsRoomListLoadingSlow.value = false;
    mockIsRoomListStuck.value = false;
    mockIsRoomListAuthoritativeEmpty.value = false;
    mockMatrixReady.value = true;
  });

  it("shows RoomListSkeleton when rooms are loading and filter is empty", () => {
    mockIsRoomListLoading.value = true;

    const wrapper = mount(ContactList, {
      props: { filter: "personal" },
      global: {
        plugins: [createTestingPinia({ stubActions: true })],
        stubs: {
          MessageStatusIcon: true,
          UserAvatar: true,
          Avatar: true,
          ContextMenu: true,
          RenameContactDialog: true,
        },
      },
    });

    expect(wrapper.find("[data-testid='room-list-skeleton']").exists()).toBe(true);
    expect(wrapper.text()).not.toBe("");
  });

  it("shows retry UI when room list is stuck", () => {
    mockIsRoomListStuck.value = true;

    const wrapper = mount(ContactList, {
      props: { filter: "personal" },
      global: {
        plugins: [createTestingPinia({ stubActions: true })],
        stubs: {
          MessageStatusIcon: true,
          UserAvatar: true,
          Avatar: true,
          ContextMenu: true,
          RenameContactDialog: true,
        },
      },
    });

    expect(wrapper.text()).toContain("contactList.syncStuck");
    expect(wrapper.text()).toContain("contactList.syncRetry");
    expect(wrapper.find("[data-testid='room-list-skeleton']").exists()).toBe(false);
  });

  it("shows no-conversations when sortedRooms has items but personal filter is empty", () => {
    mockSortedRooms.value = [
      {
        id: "!g:s",
        name: "Group",
        isGroup: true,
        membership: "join",
        members: ["aa", "bb"],
        unreadCount: 0,
        updatedAt: 1000,
      },
    ];

    const wrapper = mount(ContactList, {
      props: { filter: "personal" },
      global: {
        plugins: [createTestingPinia({ stubActions: true })],
        stubs: {
          MessageStatusIcon: true,
          UserAvatar: true,
          Avatar: true,
          ContextMenu: true,
          RenameContactDialog: true,
        },
      },
    });

    expect(wrapper.text()).toContain("contactList.noConversations");
  });
});
