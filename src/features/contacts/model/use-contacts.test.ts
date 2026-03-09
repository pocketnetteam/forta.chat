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
vi.mock("@/app/providers/initializers/app-initializer", () => ({
  createAppInitializer: vi.fn(() => ({
    searchUsers: vi.fn(() => []),
  })),
}));

// Mock MatrixClientService
const mockCreateRoom = vi.fn();
const mockJoinRoom = vi.fn();
const mockGetRooms = vi.fn((): any[] => []);
const mockGetRoom = vi.fn(() => null);
const mockSetPowerLevel = vi.fn();

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    isReady: () => true,
    getUserId: () => "@" + hexEncode("PMyAddress123456789012345678901234").toLowerCase() + ":matrix.pocketnet.app",
    createRoom: mockCreateRoom,
    joinRoom: mockJoinRoom,
    getRooms: mockGetRooms,
    getRoom: mockGetRoom,
    setPowerLevel: mockSetPowerLevel,
    sendText: vi.fn(),
  })),
  resetMatrixClientService: vi.fn(),
  MatrixClientService: vi.fn(),
}));

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
});
