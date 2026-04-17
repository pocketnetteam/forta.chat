import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "@/entities/chat";
import { hexEncode, tetatetid } from "@/shared/lib/matrix/functions";

// Mock auth store
vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(() => ({
    address: "PMyAddress123456789012345678901234",
  })),
}));

// Mock user store
const mockSetUser = vi.fn();
vi.mock("@/entities/user", () => ({
  useUserStore: vi.fn(() => ({
    users: {},
    getUser: vi.fn(() => ({ name: "TargetUser", address: "PTargetAddr12345678901234567890AB" })),
    setUser: mockSetUser,
  })),
}));

// Mock app initializer
const mockRpcSearchUsers = vi.fn<(query: string) => Promise<Array<{ address: string; name: string; image: string }>>>();
vi.mock("@/app/providers/initializers/app-initializer", () => ({
  createAppInitializer: vi.fn(() => ({
    searchUsers: (q: string) => mockRpcSearchUsers(q),
  })),
}));

// Mock MatrixClientService
const mockCreateRoom = vi.fn();
const mockJoinRoom = vi.fn();
const mockGetRooms = vi.fn((): any[] => []);
const mockGetRoom = vi.fn(() => ({ selfMembership: "join" }));
const mockSetPowerLevel = vi.fn();
const mockSearchUserDirectory = vi.fn<(term: string, limit?: number) => Promise<{ limited: boolean; results: Array<{ user_id: string; display_name?: string; avatar_url?: string }> }>>();
const mockIsReady = vi.fn(() => true);

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    isReady: () => mockIsReady(),
    getUserId: () => "@" + hexEncode("PMyAddress123456789012345678901234").toLowerCase() + ":matrix.pocketnet.app",
    createRoom: mockCreateRoom,
    joinRoom: mockJoinRoom,
    getRooms: mockGetRooms,
    getRoom: mockGetRoom,
    setPowerLevel: mockSetPowerLevel,
    sendText: vi.fn(),
    searchUserDirectory: (term: string, limit?: number) => mockSearchUserDirectory(term, limit),
  })),
  resetMatrixClientService: vi.fn(),
  MatrixClientService: vi.fn(),
}));

// Mock local-db: simulate cache miss by default. Use partial mock so that
// chat-store and other consumers still see the real useLiveQuery / repositories.
const mockCacheGet = vi.fn<(q: string) => Promise<any[] | null>>(() => Promise.resolve(null));
const mockCachePut = vi.fn<(q: string, results: any[]) => Promise<void>>(() => Promise.resolve());
vi.mock("@/shared/lib/local-db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isChatDbReady: () => true,
    getChatDb: () => ({
      searchCache: {
        get: (q: string) => mockCacheGet(q),
        put: (q: string, r: any[]) => mockCachePut(q, r),
      },
    }),
  };
});

// Mock connectivity
vi.mock("@/shared/lib/connectivity", () => ({
  useConnectivity: vi.fn(() => ({ isOnline: { value: true } })),
}));

import { useContacts } from "./use-contacts";

const MY_ADDR = "PMyAddress123456789012345678901234";
const TARGET_ADDR = "PTargetAddr12345678901234567890AB";
const MY_HEX = hexEncode(MY_ADDR).toLowerCase();
const TARGET_HEX = hexEncode(TARGET_ADDR).toLowerCase();
const EXPECTED_ALIAS = tetatetid(MY_HEX, TARGET_HEX);

describe("useContacts", () => {
  let chatStore: ReturnType<typeof useChatStore>;
  let contacts: ReturnType<typeof useContacts>;

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createTestingPinia({ stubActions: false }));
    chatStore = useChatStore();
    contacts = useContacts();
  });

  // ─── deterministic alias ────────────────────────────────────

  describe("deterministic alias", () => {
    it("computes a non-null alias for two different addresses", () => {
      expect(EXPECTED_ALIAS).toBeTruthy();
      expect(typeof EXPECTED_ALIAS).toBe("string");
      expect(EXPECTED_ALIAS!.length).toBe(56); // SHA-224 hex = 56 chars
    });

    it("alias is commutative (same result regardless of order)", () => {
      const reversed = tetatetid(TARGET_HEX, MY_HEX);
      expect(reversed).toBe(EXPECTED_ALIAS);
    });
  });

  // ─── getOrCreateRoom — finds existing ───────────────────────

  describe("getOrCreateRoom — existing room", () => {
    it("finds existing local room by canonical alias", async () => {
      mockGetRooms.mockReturnValue([
        {
          roomId: "!existing:matrix.pocketnet.app",
          getCanonicalAlias: () => `#${EXPECTED_ALIAS}:matrix.pocketnet.app`,
          name: "#" + EXPECTED_ALIAS,
          selfMembership: "join",
        },
      ]);

      const roomId = await contacts.getOrCreateRoom(TARGET_ADDR);

      expect(roomId).toBe("!existing:matrix.pocketnet.app");
      expect(mockCreateRoom).not.toHaveBeenCalled();
    });
  });

  // ─── getOrCreateRoom — creates new ──────────────────────────

  describe("getOrCreateRoom — new room", () => {
    it("creates a new room when none exists", async () => {
      mockGetRooms.mockReturnValue([]);
      mockCreateRoom.mockResolvedValue({ room_id: "!new:matrix.pocketnet.app" });

      const roomId = await contacts.getOrCreateRoom(TARGET_ADDR);

      expect(roomId).toBe("!new:matrix.pocketnet.app");
      expect(mockCreateRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          room_alias_name: EXPECTED_ALIAS,
          visibility: "private",
        })
      );
    });

    it("sets the room as active after creation", async () => {
      mockGetRooms.mockReturnValue([]);
      mockCreateRoom.mockResolvedValue({ room_id: "!new:matrix.pocketnet.app" });

      await contacts.getOrCreateRoom(TARGET_ADDR);

      expect(chatStore.activeRoomId).toBe("!new:matrix.pocketnet.app");
    });
  });

  // ─── getOrCreateRoom — M_ROOM_IN_USE rejoin ─────────────────

  describe("getOrCreateRoom — M_ROOM_IN_USE", () => {
    it("rejoins via alias when room alias is already taken", async () => {
      mockGetRooms.mockReturnValue([]);
      mockCreateRoom.mockRejectedValue({ errcode: "M_ROOM_IN_USE" });
      mockJoinRoom.mockResolvedValue({ room_id: "!rejoined:matrix.pocketnet.app" });

      const roomId = await contacts.getOrCreateRoom(TARGET_ADDR);

      expect(roomId).toBe("!rejoined:matrix.pocketnet.app");
      expect(mockJoinRoom).toHaveBeenCalled();
    });
  });

  // ─── searchUsers — multi-tier fallback ──────────────────────

  describe("searchUsers — multi-tier fallback", () => {
    beforeEach(() => {
      mockRpcSearchUsers.mockReset();
      mockSearchUserDirectory.mockReset();
      mockCacheGet.mockReset().mockResolvedValue(null);
      mockCachePut.mockReset().mockResolvedValue(undefined);
      mockIsReady.mockReturnValue(true);
    });

    it("returns RPC results directly when Bastyon RPC works", async () => {
      mockRpcSearchUsers.mockResolvedValue([
        { address: "PBob1111111111111111111111111111AA", name: "Bob", image: "" },
      ]);
      mockSearchUserDirectory.mockResolvedValue({ limited: false, results: [] });

      await contacts.searchUsers("bob");

      expect(contacts.searchResults.value.length).toBe(1);
      expect(contacts.searchResults.value[0].name).toBe("Bob");
      expect(contacts.searchError.value).toBeNull();
    });

    it("falls back to Matrix user_directory when Bastyon RPC fails (CORS on web)", async () => {
      mockRpcSearchUsers.mockRejectedValue(new Error("Failed to fetch"));
      const targetHex = hexEncode("PAlice22222222222222222222222222AB").toLowerCase();
      mockSearchUserDirectory.mockResolvedValue({
        limited: false,
        results: [{ user_id: `@${targetHex}:matrix.pocketnet.app`, display_name: "Alice", avatar_url: "" }],
      });

      await contacts.searchUsers("alice");

      expect(mockSearchUserDirectory).toHaveBeenCalledWith("alice", 20);
      expect(contacts.searchResults.value.length).toBeGreaterThan(0);
      expect(contacts.searchResults.value[0].address).toBe("PAlice22222222222222222222222222AB");
      expect(contacts.searchError.value).toBeNull();
    });

    it("surfaces localized search.userNotFound when all tiers return nothing", async () => {
      mockRpcSearchUsers.mockResolvedValue([]);
      mockSearchUserDirectory.mockResolvedValue({ limited: false, results: [] });

      await contacts.searchUsers("nonexistent_xyz");

      expect(contacts.searchResults.value.length).toBe(0);
      // Must never be the raw SDK string — only an i18n key.
      expect(contacts.searchError.value).toBe("search.userNotFound");
    });

    it("never exposes raw SDK error strings to searchError", async () => {
      mockRpcSearchUsers.mockRejectedValue(new Error("Невозможно разыскать идентификатор"));
      mockSearchUserDirectory.mockRejectedValue(new Error("Невозможно разыскать идентификатор"));
      mockIsReady.mockReturnValue(true);

      await contacts.searchUsers("badquery");

      // searchError is either null (local results found) or an i18n key — never
      // the raw Russian phrase that was previously leaking from the SDK.
      expect(contacts.searchError.value).not.toContain("Невозможно");
      if (contacts.searchError.value) {
        expect(contacts.searchError.value).toMatch(/^search\./);
      }
    });

    // ─── Security: malformed user_directory input ────────────

    it("rejects Matrix results whose decoded address is not Bastyon-shaped", async () => {
      mockRpcSearchUsers.mockRejectedValue(new Error("CORS"));
      // Hex-encoded pure garbage 200 bytes of 'A' — decoded length exceeds
      // the 25-40 char window, so normalizeMatrixDirectoryUser must reject it.
      const oversizedHex = "41".repeat(200);
      mockSearchUserDirectory.mockResolvedValue({
        limited: false,
        results: [{ user_id: `@${oversizedHex}:matrix.pocketnet.app`, display_name: "Attacker", avatar_url: "" }],
      });

      await contacts.searchUsers("attack");

      expect(contacts.searchResults.value.length).toBe(0);
      expect(contacts.searchError.value).toBe("search.userNotFound");
    });

    it("rejects Matrix results with non-alphanumeric decoded bytes", async () => {
      mockRpcSearchUsers.mockRejectedValue(new Error("CORS"));
      // 0x00 and 0x01 (NUL/SOH) encode back to control chars — must be rejected.
      const controlHex = "00".repeat(34);
      mockSearchUserDirectory.mockResolvedValue({
        limited: false,
        results: [{ user_id: `@${controlHex}:matrix.pocketnet.app`, display_name: "Control", avatar_url: "" }],
      });

      await contacts.searchUsers("ctrl");

      expect(contacts.searchResults.value.length).toBe(0);
    });

    // ─── Race condition: fast typing must not show stale results ─

    it("discards a slow earlier call when a newer call has started", async () => {
      // Stage: "slow" returns old results after a delay; "fast" returns fresh
      // results immediately. Caller awaits the earlier promise last. The fast
      // call's results must stay; the slow call must NOT overwrite them.
      let resolveSlow: (v: Array<{ address: string; name: string; image: string }>) => void = () => {};
      const slowPromise = new Promise<Array<{ address: string; name: string; image: string }>>(
        resolve => { resolveSlow = resolve; },
      );

      mockRpcSearchUsers.mockImplementationOnce(() => slowPromise);
      mockRpcSearchUsers.mockImplementationOnce(async () => [
        { address: "PFreshFresh1111111111111111111111AB", name: "Fresh", image: "" },
      ]);
      mockSearchUserDirectory.mockResolvedValue({ limited: false, results: [] });

      const slowCall = contacts.searchUsers("query-old");
      // Start a second, "fresh" call before the first resolves
      await contacts.searchUsers("query-new");

      // Now resolve the slow call's RPC with stale results
      resolveSlow([
        { address: "PStaleStale11111111111111111111AB", name: "Stale", image: "" },
      ]);
      await slowCall;

      // Only the fresh results should be visible — stale must be discarded.
      expect(contacts.searchResults.value.find(u => u.name === "Fresh")).toBeTruthy();
      expect(contacts.searchResults.value.find(u => u.name === "Stale")).toBeUndefined();
    });

    it("uses Dexie TTL cache on cache hit", async () => {
      mockCacheGet.mockResolvedValue([
        { address: "PCached11111111111111111111111111AB", name: "Cached", image: "" },
      ]);
      mockRpcSearchUsers.mockResolvedValue([]);
      mockSearchUserDirectory.mockResolvedValue({ limited: false, results: [] });

      await contacts.searchUsers("cached");

      expect(mockCacheGet).toHaveBeenCalledWith("cached");
      // Cached result should appear immediately (prior to tier 2/3).
      expect(contacts.searchResults.value.find(u => u.address === "PCached11111111111111111111111111AB")).toBeTruthy();
    });

    it("persists merged results to Dexie cache after tiers complete", async () => {
      mockRpcSearchUsers.mockResolvedValue([
        { address: "PWriteCache11111111111111111111AB", name: "WriteCache", image: "" },
      ]);
      mockSearchUserDirectory.mockResolvedValue({ limited: false, results: [] });

      await contacts.searchUsers("writecache");

      expect(mockCachePut).toHaveBeenCalled();
      const call = mockCachePut.mock.calls[0];
      expect(call[0]).toBe("writecache");
      expect(call[1]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ address: "PWriteCache11111111111111111111AB" }),
        ]),
      );
    });

    it("filters out own address from Matrix fallback results", async () => {
      mockRpcSearchUsers.mockRejectedValue(new Error("Failed to fetch"));
      const myHex = hexEncode(MY_ADDR).toLowerCase();
      mockSearchUserDirectory.mockResolvedValue({
        limited: false,
        results: [
          { user_id: `@${myHex}:matrix.pocketnet.app`, display_name: "Me", avatar_url: "" },
        ],
      });

      await contacts.searchUsers("me");

      expect(contacts.searchResults.value.find(u => u.address === MY_ADDR)).toBeUndefined();
    });
  });
});
