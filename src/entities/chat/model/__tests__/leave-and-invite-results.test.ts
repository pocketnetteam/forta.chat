// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeRoom } from "@/test-utils";

/**
 * Audit S7-01 / S3b-03 and the batch-4 review. A failed leave brings the room
 * back and says so, unless /sync already reported the user out (the leave
 * reached the server and only its answer was lost); a failed forget after a
 * successful leave is not a failed leave; accepting an invite reports why it
 * did not join.
 */

let sdkMembership: string | undefined = "join";
const mockMatrixService = {
  getUserId: vi.fn(() => "@me:server"),
  getRoom: vi.fn(() => (sdkMembership === undefined ? null : { selfMembership: sdkMembership })),
  isReady: vi.fn(() => false),
  leaveRoom: vi.fn(async () => {}),
  forgetRoom: vi.fn(async () => {}),
  joinRoom: vi.fn(async () => {}),
  sendReadReceipt: vi.fn(async () => true),
  kit: {
    client: { getUserId: vi.fn(() => "@me:server") },
    isTetatetChat: vi.fn(() => false),
    getRoomMembers: vi.fn(() => []),
  },
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

const toast = vi.fn();
vi.mock("@/shared/lib/use-toast", () => ({
  useToast: () => ({ toast }),
}));

import { useChatStore } from "../chat-store";

describe("leaving a group (audit S7-01)", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    sdkMembership = "join";
    toast.mockClear();
    mockMatrixService.leaveRoom.mockReset().mockResolvedValue(undefined);
    mockMatrixService.forgetRoom.mockReset().mockResolvedValue(undefined);
  });

  it("reports a refused leave and says so", async () => {
    mockMatrixService.leaveRoom.mockRejectedValueOnce(new Error("network"));

    await expect(store.leaveGroup("!g:s")).resolves.toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("keeps the room left when /sync already has the user out, although the leave call failed", async () => {
    mockMatrixService.leaveRoom.mockRejectedValueOnce(new Error("timeout"));
    sdkMembership = "leave";

    await expect(store.leaveGroup("!g:s")).resolves.toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not call a failed forget after a successful leave a failed leave", async () => {
    mockMatrixService.forgetRoom.mockRejectedValueOnce(new Error("forget"));

    await expect(store.leaveGroup("!g:s")).resolves.toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it("removeRoom reports a refused leave the same way", async () => {
    mockMatrixService.leaveRoom.mockRejectedValueOnce(new Error("network"));

    await expect(store.removeRoom("!g:s")).resolves.toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.any(String), "error");
  });
});

describe("accepting an invite (audit S3b-03)", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    sdkMembership = "invite";
    mockMatrixService.joinRoom.mockReset().mockResolvedValue(undefined);
  });

  it("reports a join that worked", async () => {
    store.rooms.push(makeRoom({ id: "!inv:s", membership: "invite" }));
    await expect(store.acceptInvite("!inv:s")).resolves.toBe("joined");
  });

  it("reports a join that failed", async () => {
    mockMatrixService.joinRoom.mockRejectedValueOnce(new Error("network"));
    await expect(store.acceptInvite("!inv:s")).resolves.toBe("failed");
  });
});
