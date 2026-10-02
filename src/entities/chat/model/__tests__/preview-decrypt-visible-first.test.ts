/**
 * Roadmap stage 3: encrypted sidebar previews decrypt what is on screen
 * first. Preview passes used to walk every room in SDK order, 20 at a time,
 * so the visible rows waited behind rooms the user could not see — and each
 * of those cost a key request. Once the sidebar reports its rows, only they
 * (and the open chat) are decrypted; the rest waits until scrolled into view.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeRoom, makeMsg } from "@/test-utils";

const encryptedEvent = (id: string) => ({
  event: {
    type: "m.room.message",
    sender: "@peer:server",
    content: { msgtype: "m.encrypted", body: "b64..." },
    event_id: id,
    origin_server_ts: 1000,
  },
});

const mxRooms = new Map<string, unknown>();
const mockMatrixService = {
  getUserId: vi.fn(() => "@me:server"),
  getRoom: vi.fn((id: string) => mxRooms.get(id)),
  getRooms: vi.fn(() => [...mxRooms.values()]),
  isReady: vi.fn(() => true),
  sendReadReceipt: vi.fn(async () => true),
  kit: {
    client: { getUserId: () => "@me:server" },
    isTetatetChat: vi.fn(() => true),
    getRoomMembers: vi.fn(() => []),
  },
};
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

import { useChatStore } from "../chat-store";

const ROOMS = ["!a:s", "!b:s", "!c:s", "!d:s"];

describe("chat-store — sidebar previews: visible rows first", () => {
  let store: ReturnType<typeof useChatStore>;
  let decryptOrder: string[];
  let gate: Promise<void> | null;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    decryptOrder = [];
    gate = null;
    mxRooms.clear();
    const roomsCrypto: Record<string, unknown> = {};
    for (const id of ROOMS) {
      mxRooms.set(id, { roomId: id, getLiveTimeline: () => ({ getEvents: () => [encryptedEvent(`$${id}`)] }) });
      roomsCrypto[id] = {
        decryptEvent: vi.fn(async () => {
          decryptOrder.push(id);
          if (gate) await gate;
          return { body: `plain ${id}`, msgtype: "m.text" };
        }),
      };
      store.addRoom(makeRoom({ id, lastMessage: makeMsg({ id: `$${id}`, roomId: id, content: "[encrypted]" }) }));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, { rooms: roomsCrypto } as any);
  });

  const preview = (id: string) => store.rooms.find((r) => r.id === id)?.lastMessage?.content;

  it("decrypts the reported rows right away", async () => {
    store.setVisibleSidebarRooms(["!b:s", "!c:s"]);
    await vi.waitFor(() => expect(preview("!c:s")).toBe("plain !c:s"));
    expect(preview("!b:s")).toBe("plain !b:s");
    expect(decryptOrder.sort()).toEqual(["!b:s", "!c:s"]);
  });

  it("later passes skip rows that are not on screen", async () => {
    store.setVisibleSidebarRooms(["!b:s"]);
    await vi.waitFor(() => expect(preview("!b:s")).toBe("plain !b:s"));

    store.retryEncryptedPreviews();
    await new Promise((r) => setTimeout(r, 30));
    expect(decryptOrder).toEqual(["!b:s"]);
    expect(preview("!a:s")).toBe("[encrypted]");
  });

  it("rows scrolled into view are decrypted when reported", async () => {
    store.setVisibleSidebarRooms(["!a:s"]);
    await vi.waitFor(() => expect(preview("!a:s")).toBe("plain !a:s"));
    store.setVisibleSidebarRooms(["!d:s"]);
    await vi.waitFor(() => expect(preview("!d:s")).toBe("plain !d:s"));
  });

  it("decrypts rows top to bottom", async () => {
    store.setVisibleSidebarRooms(["!c:s", "!a:s"]);
    await vi.waitFor(() => expect(decryptOrder).toHaveLength(2));
    expect(decryptOrder).toEqual(["!c:s", "!a:s"]);
  });

  it("the open chat goes ahead of the rows", async () => {
    store.activeRoomId = "!d:s";
    store.retryEncryptedPreviews();
    await vi.waitFor(() => expect(decryptOrder).toHaveLength(4));
    expect(decryptOrder[0]).toBe("!d:s");
  });

  it("the open chat is decrypted even when its row is not on screen", async () => {
    store.activeRoomId = "!d:s";
    store.setVisibleSidebarRooms(["!a:s"]);
    store.retryEncryptedPreviews();
    await vi.waitFor(() => expect(preview("!d:s")).toBe("plain !d:s"));
    expect(decryptOrder.sort()).toEqual(["!a:s", "!d:s"]);
  });

  it("an empty report (tab without chat rows) stops decrypting the previous tab's rows", async () => {
    store.setVisibleSidebarRooms(["!a:s"]);
    await vi.waitFor(() => expect(preview("!a:s")).toBe("plain !a:s"));
    store.setVisibleSidebarRooms([]);
    store.retryEncryptedPreviews();
    await new Promise((r) => setTimeout(r, 30));
    expect(decryptOrder).toEqual(["!a:s"]);
  });

  it("an unmounted list releases its rows — passes cover every room again", async () => {
    const list = Symbol("list");
    store.setVisibleSidebarRooms(["!a:s"], list);
    await vi.waitFor(() => expect(preview("!a:s")).toBe("plain !a:s"));
    store.releaseVisibleSidebarRooms(list, "unmounted");
    store.retryEncryptedPreviews();
    await vi.waitFor(() => expect(decryptOrder).toHaveLength(4));
  });

  it("a hidden tab releases its rows to an empty set", async () => {
    const list = Symbol("list");
    store.setVisibleSidebarRooms(["!a:s"], list);
    await vi.waitFor(() => expect(preview("!a:s")).toBe("plain !a:s"));
    store.releaseVisibleSidebarRooms(list, "hidden");
    store.retryEncryptedPreviews();
    await new Promise((r) => setTimeout(r, 30));
    expect(decryptOrder).toEqual(["!a:s"]);
  });

  it("a release from a list that is no longer the reporter is ignored", async () => {
    const oldTab = Symbol("old");
    const newTab = Symbol("new");
    store.setVisibleSidebarRooms(["!a:s"], oldTab);
    store.setVisibleSidebarRooms(["!b:s"], newTab);
    store.releaseVisibleSidebarRooms(oldTab, "hidden");
    await vi.waitFor(() => expect(preview("!b:s")).toBe("plain !b:s"));
    store.retryEncryptedPreviews();
    await new Promise((r) => setTimeout(r, 30));
    expect(decryptOrder.sort()).toEqual(["!a:s", "!b:s"]);
    expect(preview("!c:s")).toBe("[encrypted]");
  });

  it("a failed row is released at once, so a key-arrival retry is not lost behind its batch", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let failA = true;
    const roomsCrypto = {
      "!a:s": {
        decryptEvent: vi.fn(async () => {
          if (failA) throw new Error("keys not loaded");
          return { body: "plain !a:s", msgtype: "m.text" };
        }),
      },
      "!b:s": {
        decryptEvent: vi.fn(async () => {
          await slow;
          return { body: "plain !b:s", msgtype: "m.text" };
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, { rooms: roomsCrypto } as any);
    store.setVisibleSidebarRooms(["!a:s", "!b:s"]);
    await vi.waitFor(() => expect(roomsCrypto["!a:s"].decryptEvent).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(roomsCrypto["!b:s"].decryptEvent).toHaveBeenCalledTimes(1));

    // Keys for !a arrive while !b is still decrypting
    failA = false;
    store.retryRoomPreview("!a:s");
    await vi.waitFor(() => expect(preview("!a:s")).toBe("plain !a:s"));
    release();
    await vi.waitFor(() => expect(preview("!b:s")).toBe("plain !b:s"));
  });

  it("a pass that found the row in flight re-runs it if the running attempt fails", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const roomsCrypto = {
      "!a:s": {
        decryptEvent: vi.fn(async () => {
          calls++;
          if (calls === 1) {
            await slow;
            throw new Error("keys not loaded yet");
          }
          return { body: "plain !a:s", msgtype: "m.text" };
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, { rooms: roomsCrypto } as any);
    store.setVisibleSidebarRooms(["!a:s"]);
    await vi.waitFor(() => expect(calls).toBe(1));

    store.retryRoomPreview("!a:s"); // keys arrived while the first attempt runs
    release();
    await vi.waitFor(() => expect(preview("!a:s")).toBe("plain !a:s"));
    expect(calls).toBe(2);
  });

  it("an ordinary pass over an in-flight row does not bypass the retry delay", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const roomsCrypto = {
      "!a:s": {
        decryptEvent: vi.fn(async () => {
          calls++;
          if (calls === 1) await slow;
          throw new Error("peer has no keys");
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, { rooms: roomsCrypto } as any);
    store.setVisibleSidebarRooms(["!a:s"]);
    await vi.waitFor(() => expect(calls).toBe(1));

    store.setVisibleSidebarRooms(["!a:s"]); // scroll / reorder, not key arrival
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
  });

  it("keeps the open chat in the capped window when every room is eligible", async () => {
    const many: string[] = [];
    const roomsCrypto: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
      const id = `!r${i}:s`;
      many.push(id);
      mxRooms.set(id, { roomId: id, getLiveTimeline: () => ({ getEvents: () => [encryptedEvent(`$${id}`)] }) });
      roomsCrypto[id] = {
        decryptEvent: vi.fn(async () => {
          decryptOrder.push(id);
          throw new Error("cold");
        }),
      };
      store.addRoom(makeRoom({ id, lastMessage: makeMsg({ id: `$${id}`, roomId: id, content: "[encrypted]" }) }));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, { rooms: roomsCrypto } as any);
    store.activeRoomId = "!r24:s";
    mockMatrixService.getRooms.mockReturnValueOnce(many.map((id) => mxRooms.get(id)));

    store.retryEncryptedPreviews();
    await vi.waitFor(() => expect(decryptOrder).toHaveLength(20));
    expect(decryptOrder[0]).toBe("!r24:s");
  });

  it("does not start a row again while its decrypt is still running", async () => {
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    store.setVisibleSidebarRooms(["!a:s"]);
    await vi.waitFor(() => expect(decryptOrder).toEqual(["!a:s"]));
    store.setVisibleSidebarRooms(["!a:s"]);
    store.setVisibleSidebarRooms(["!a:s"]);
    release();
    await vi.waitFor(() => expect(preview("!a:s")).toBe("plain !a:s"));
    expect(decryptOrder).toEqual(["!a:s"]);
  });

  it("retryRoomPreview retries a visible row whose retry budget was spent", async () => {
    let fail = true;
    const roomsCrypto = {
      "!a:s": {
        decryptEvent: vi.fn(async () => {
          if (fail) throw new Error("keys not loaded");
          return { body: "plain !a:s", msgtype: "m.text" };
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, { rooms: roomsCrypto } as any);
    store.setVisibleSidebarRooms(["!a:s"]);
    await vi.waitFor(() => expect(roomsCrypto["!a:s"].decryptEvent).toHaveBeenCalledTimes(1));

    fail = false;
    store.retryRoomPreview("!a:s");
    await vi.waitFor(() => expect(preview("!a:s")).toBe("plain !a:s"));
  });
});
