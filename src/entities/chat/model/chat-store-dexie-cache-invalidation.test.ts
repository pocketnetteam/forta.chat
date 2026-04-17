import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import type { ChatDbKit } from "@/shared/lib/local-db";
import type { LocalRoom } from "@/shared/lib/local-db";
import type { RoomChange } from "@/shared/lib/local-db";
import { useChatStore } from "./chat-store";

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getUserId: vi.fn(() => "@me:server"),
    getRoom: vi.fn(() => ({ selfMembership: "join" })),
    client: {},
    matrixId: vi.fn((hex: string) => `@${hex}:server`),
    isUserIgnored: vi.fn(() => false),
    isReady: vi.fn(() => false),
    kit: {
      client: { getUserId: vi.fn(() => "@me:server") },
      isTetatetChat: vi.fn(() => true),
      getRoomMembers: vi.fn(() => []),
    },
  })),
}));

async function waitFor(cond: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise(r => setTimeout(r, 5));
  }
}

function makeLocalRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: "!cache-inv:s",
    name: "Room",
    isGroup: true,
    members: ["aaaaaaaa", "bbbbbbbb"],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: 5000,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    syncedAt: 1,
    hasMoreHistory: true,
    lastMessageTimestamp: 0,
    lastMessagePreview: undefined,
    ...overrides,
  } as LocalRoom;
}

describe("mapLocalRoomToChatRoom cache (Dexie path)", () => {
  let store: ReturnType<typeof useChatStore>;
  let roomObserver: ((changes: RoomChange[]) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    roomObserver = null;
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  afterEach(() => {
    store.cleanup();
  });

  function mockKit(initialRooms: LocalRoom[]): ChatDbKit {
    return {
      db: {} as ChatDbKit["db"],
      messages: {
        getMessages: vi.fn(async () => []),
        getLastInboundTimestamp: vi.fn(async () => 0),
      } as unknown as ChatDbKit["messages"],
      rooms: {
        getAllRooms: vi.fn(async () => initialRooms),
        observeRoomChanges: vi.fn((cb: (changes: RoomChange[]) => void) => {
          roomObserver = cb;
          return () => { roomObserver = null; };
        }),
      } as unknown as ChatDbKit["rooms"],
      users: {} as ChatDbKit["users"],
      syncEngine: {} as ChatDbKit["syncEngine"],
      eventWriter: {
        enableBatching: vi.fn(),
        setClearedAtTs: vi.fn(),
        getClearedAtTs: vi.fn(() => undefined),
        disposeBuffer: vi.fn(),
      } as unknown as ChatDbKit["eventWriter"],
      decryptionWorker: {} as ChatDbKit["decryptionWorker"],
      listened: {} as ChatDbKit["listened"],
    };
  }

  it("invalidates cached ChatRoom when members change but last-message preview/timestamp do not", async () => {
    const r0 = makeLocalRoom({
      members: ["11111111"],
      lastMessageTimestamp: 0,
      lastMessagePreview: undefined,
    });
    store.setChatDbKit(mockKit([r0]));
    await waitFor(() => store.sortedRooms.some(x => x.id === "!cache-inv:s"));

    const first = store.sortedRooms.find(x => x.id === "!cache-inv:s")!;
    expect(first.members).toEqual(["11111111"]);

    const r1 = makeLocalRoom({
      members: ["11111111", "22222222"],
      lastMessageTimestamp: 0,
      lastMessagePreview: undefined,
      updatedAt: r0.updatedAt,
    });
    expect(roomObserver).not.toBeNull();
    roomObserver!([{ type: "upsert", room: r1 }]);

    await waitFor(() => store.sortedRooms.find(x => x.id === "!cache-inv:s")?.members.length === 2);
    const second = store.sortedRooms.find(x => x.id === "!cache-inv:s")!;
    expect(second.members).toEqual(["11111111", "22222222"]);
  });

  it("invalidates cached ChatRoom when updatedAt changes with same preview", async () => {
    const r0 = makeLocalRoom({ updatedAt: 100, lastMessageTimestamp: 50, lastMessagePreview: "hi" });
    store.setChatDbKit(mockKit([r0]));
    await waitFor(() => store.sortedRooms.some(x => x.id === "!cache-inv:s"));

    const r1 = makeLocalRoom({
      ...r0,
      updatedAt: 999,
      lastMessageTimestamp: 50,
      lastMessagePreview: "hi",
    });
    roomObserver!([{ type: "upsert", room: r1 }]);

    await waitFor(() => store.sortedRooms.find(x => x.id === "!cache-inv:s")?.updatedAt === 999);
    expect(store.sortedRooms.find(x => x.id === "!cache-inv:s")!.updatedAt).toBe(999);
  });
});
