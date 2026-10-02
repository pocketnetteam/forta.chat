// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";

// ── Mock MatrixClientService ───────────────────────────────────────
// `sdkRoom` is flipped by the tests to simulate matrix-js-sdk materializing
// the Room object late — the state behind "encryption keys are still loading"
// on a chat that had already been opened before.
let sdkRoom: unknown = null;

const mockMatrixService = {
  getUserId: vi.fn(() => "@me:server"),
  getRoom: vi.fn(() => sdkRoom),
  isReady: vi.fn(() => false),
  getRoomAccountData: vi.fn(() => undefined),
  sendReadReceipt: vi.fn(async () => true),
  scrollback: vi.fn(async () => {}),
  kit: {
    client: { getUserId: vi.fn(() => "@me:server") },
    isTetatetChat: vi.fn(() => true),
    getRoomMembers: vi.fn(() => []),
  },
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

import { useChatStore } from "./chat-store";

const ROOM_ID = "!dm:matrix.org";

const LOCAL_ROOM = {
  id: ROOM_ID,
  name: "maxim",
  avatar: undefined,
  isGroup: false,
  members: ["me", "peer"],
  membership: "join",
  unreadCount: 0,
  topic: undefined,
  updatedAt: 1_000,
  lastMessageTimestamp: 1_000,
  lastMessagePreview: "hi",
  lastMessageSenderId: "peer",
  lastMessageEventId: "$e1",
  isDeleted: false,
};

/** SDK Room stub with just enough shape for the open path: no join_rules state
 *  (so it reads as a private room) and an empty, fully-paginated timeline. */
function makeSdkRoom() {
  return {
    roomId: ROOM_ID,
    selfMembership: "join",
    getMyMembership: () => "join",
    getJoinedMemberCount: () => 2,
    oldState: { paginationToken: null },
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getUnfilteredTimelineSet: () => ({ getLiveTimeline: () => ({ getEvents: () => [] }) }),
    loadMembersIfNeeded: () => Promise.resolve(),
    getMembers: () => [],
  };
}

function makePcrypto() {
  const rooms: Record<string, unknown> = {};
  const instance = {
    canBeEncrypt: () => true,
    requiresEncryption: () => true,
    prepare: vi.fn(async () => instance),
  };
  const addRoom = vi.fn(async (chat: Record<string, unknown>) => {
    rooms[chat.roomId as string] = instance;
    return instance;
  });
  return { rooms, addRoom, instance };
}

function makeKit(rooms: unknown[]) {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => rooms),
      observeRoomChanges: vi.fn(() => () => {}),
      bulkSyncRooms: vi.fn(async () => {}),
      getRoom: vi.fn(async () => undefined),
      updateOutboundWatermark: vi.fn(async () => {}),
    },
    messages: {
      getMessages: vi.fn(async () => []),
      patchUnresolvedReplies: vi.fn(async () => {}),
      updateReactions: vi.fn(async () => {}),
      getByEventIds: vi.fn(async () => []),
    },
    eventWriter: {
      enableBatching: vi.fn(),
      getClearedAtTs: vi.fn(() => undefined),
      setClearedAtTs: vi.fn(),
      flushWriteBuffer: vi.fn(() => Promise.resolve()),
      hasBufferedWritesFor: vi.fn(() => false),
      clearUnread: vi.fn(async () => {}),
      writeMessages: vi.fn(() => Promise.resolve()),
      writeEdit: vi.fn(async () => {}),
    },
    db: { rooms: { update: vi.fn(async () => 1) } },
    retryRoomDecryption: vi.fn(),
  };
}

async function waitFor(fn: () => boolean, timeout = 12_000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("room crypto registration on the room-open path", () => {
  let store: ReturnType<typeof useChatStore>;
  let pcrypto: ReturnType<typeof makePcrypto>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    sdkRoom = null;
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    pcrypto = makePcrypto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers({} as any, pcrypto as any);
  });

  afterEach(() => {
    store.setActiveRoom(null);
    vi.restoreAllMocks();
  });

  it("registers the open room instead of only observing the map", async () => {
    // Reading `pcrypto.rooms` alone left the status at "unknown" forever:
    // ensureRoomCrypto is the ONLY code that populates the map, and nothing on
    // the room-open path called it.
    sdkRoom = makeSdkRoom();
    store.setActiveRoom(ROOM_ID);

    const status = await store.checkPeerKeys(ROOM_ID);

    expect(pcrypto.addRoom).toHaveBeenCalledTimes(1);
    expect(pcrypto.rooms[ROOM_ID]).toBe(pcrypto.instance);
    expect(status).toBe("available");
  });

  it("reuses an already registered instance without re-adding it", async () => {
    sdkRoom = makeSdkRoom();
    store.setActiveRoom(ROOM_ID);

    await store.checkPeerKeys(ROOM_ID);
    await store.checkPeerKeys(ROOM_ID);

    expect(pcrypto.addRoom).toHaveBeenCalledTimes(1);
  });

  it("does not register rooms the user has not opened", async () => {
    // The bulk callers (the auth store's member-event recheck fires for every
    // room emitting a membership event) only refresh a banner. Registering
    // there would turn an initial sync into dozens of addRoom → prepare() →
    // getusersinfo round-trips for rooms the user never opened.
    sdkRoom = makeSdkRoom();
    store.setActiveRoom(null);

    const status = await store.checkPeerKeys(ROOM_ID);

    expect(pcrypto.addRoom).not.toHaveBeenCalled();
    expect(status).toBe("unknown");
  });

  it("reports unknown while the SDK has no room, without inventing an instance", async () => {
    sdkRoom = null;
    store.setActiveRoom(ROOM_ID);

    const status = await store.checkPeerKeys(ROOM_ID);

    expect(status).toBe("unknown");
    expect(pcrypto.addRoom).not.toHaveBeenCalled();
  });

  it("builds one instance when concurrent callers register the same room", async () => {
    // pcrypto.addRoom awaits createPcryptoRoom BEFORE assigning rooms[roomId],
    // so without coalescing two callers both see an empty slot and both build
    // an instance. The loser's is dropped from the map while its caller keeps
    // decrypting through an orphan no key refresh will ever reach.
    sdkRoom = makeSdkRoom();
    store.setActiveRoom(ROOM_ID);

    await Promise.all([
      store.checkPeerKeys(ROOM_ID),
      store.checkPeerKeys(ROOM_ID),
      store.checkPeerKeys(ROOM_ID),
    ]);

    expect(pcrypto.addRoom).toHaveBeenCalledTimes(1);
  });
});

describe("concurrent loads of one room are coalesced", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    mockMatrixService.scrollback.mockClear();
    // Timeline short enough to trigger scrollback, so each run is observable.
    sdkRoom = { ...makeSdkRoom(), oldState: { paginationToken: "t0" } };
  });

  afterEach(() => {
    store.setActiveRoom(null);
    vi.restoreAllMocks();
  });

  it("runs the timeline pagination once for parallel callers", async () => {
    // The open path, the viewport preloader and the SDK-materialization
    // watcher can all target the same room at once; each run paginates and
    // decrypts before racing the others on setMessages and the Dexie write.
    const [a, b] = await Promise.all([
      store.loadRoomMessages(ROOM_ID),
      store.loadRoomMessages(ROOM_ID),
    ]);

    expect(mockMatrixService.scrollback).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  }, 20_000);

  it("starts a fresh run once the previous one has finished", async () => {
    await store.loadRoomMessages(ROOM_ID);
    await store.loadRoomMessages(ROOM_ID);

    expect(mockMatrixService.scrollback).toHaveBeenCalledTimes(2);
  }, 20_000);
});

describe("active room recovers once the SDK materializes it", () => {
  let store: ReturnType<typeof useChatStore>;
  let pcrypto: ReturnType<typeof makePcrypto>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    sdkRoom = null;
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    pcrypto = makePcrypto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers({} as any, pcrypto as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit([LOCAL_ROOM]) as any);
  });

  afterEach(() => {
    store.setActiveRoom(null);
    vi.restoreAllMocks();
  });

  it("replays the open path when the room arrives after the chat was opened", async () => {
    await waitFor(() => store.sortedRooms.length === 1);

    // Opened while the SDK still has nothing: every SDK-backed path no-ops and
    // `pcrypto.rooms` stays empty, so media decrypt fails with
    // CryptoNotReadyError ("encryption keys are still loading").
    store.setActiveRoom(ROOM_ID);
    expect(pcrypto.addRoom).not.toHaveBeenCalled();

    // Sync catches up.
    sdkRoom = makeSdkRoom();

    await waitFor(() => pcrypto.addRoom.mock.calls.length > 0);
    expect(pcrypto.rooms[ROOM_ID]).toBe(pcrypto.instance);
    await waitFor(() => store.peerKeysStatus.get(ROOM_ID) === "available");
  }, 20_000);

  it("does not replay for a room the user already left", async () => {
    await waitFor(() => store.sortedRooms.length === 1);

    store.setActiveRoom(ROOM_ID);
    store.setActiveRoom(null);

    sdkRoom = makeSdkRoom();
    // Past the watcher's 4s head start plus a poll tick, so a watcher that
    // ignored the room switch would have fired by now.
    await new Promise((r) => setTimeout(r, 6_000));

    expect(pcrypto.addRoom).not.toHaveBeenCalled();
  }, 20_000);

  it("does not start a watcher when the room is already in the SDK", async () => {
    await waitFor(() => store.sortedRooms.length === 1);
    sdkRoom = makeSdkRoom();

    store.setActiveRoom(ROOM_ID);
    await new Promise((r) => setTimeout(r, 6_000));

    // The normal open path owns this case; the watcher must stay out of it.
    expect(pcrypto.addRoom).not.toHaveBeenCalled();
  }, 20_000);
});
