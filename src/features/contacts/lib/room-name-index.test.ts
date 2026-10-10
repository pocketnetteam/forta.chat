import { describe, it, expect, vi } from "vitest";
import type { ChatRoom } from "@/entities/chat";
import { createRoomNameResolver, sameSet } from "./room-name-index";

const room = (id: string, over: Partial<ChatRoom> = {}): ChatRoom =>
  ({ id, name: id, members: [`m-${id}`], isGroup: false, ...over }) as ChatRoom;

interface Ctx { names: Record<string, string> }

const setup = () => {
  const resolve = vi.fn((r: ChatRoom, ctx: Ctx) => {
    const name = ctx.names[r.members[0]];
    return { name: name ?? r.name, hasMemberNames: !!name };
  });
  return { resolve, get: createRoomNameResolver<Ctx>(resolve) };
};

describe("createRoomNameResolver", () => {
  it("resolves only the rooms that are asked for", () => {
    const { resolve, get } = setup();
    const ctx = { names: { "m-a": "Alice" } };
    expect(get(room("a"), ctx)).toEqual({ name: "Alice", hasMemberNames: true });
    expect(get(room("b"), ctx)).toEqual({ name: "b", hasMemberNames: false });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("reuses the entry for a patched room object with the same name fields", () => {
    const { resolve, get } = setup();
    const ctx = { names: { "m-a": "Alice" } };
    const a = room("a");
    const first = get(a, ctx);
    resolve.mockClear();
    // A receipt-style patch: new object that keeps its member list.
    expect(get({ ...a, unreadCount: 3 }, ctx)).toBe(first);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("re-resolves a room when its member list is reassigned", () => {
    const { resolve, get } = setup();
    const ctx = { names: { "m-x": "Xavier" } };
    get(room("b"), ctx);
    resolve.mockClear();
    expect(get(room("b", { members: ["m-x"] }), ctx).name).toBe("Xavier");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  // Regression (perf): a profile batch (new context) used to re-resolve every room in
  // the list — thousands with invites — instead of the rows being displayed.
  it("re-resolves after a context change only the rooms asked for again", () => {
    const { resolve, get } = setup();
    const rooms = Array.from({ length: 1000 }, (_, i) => room(`r${i}`));
    const ctx1 = { names: {} };
    for (const r of rooms) get(r, ctx1);
    resolve.mockClear();
    const ctx2 = { names: { "m-r1": "Bob" } };
    for (const r of rooms.slice(0, 50)) get(r, ctx2);
    expect(resolve).toHaveBeenCalledTimes(50);
    expect(get(rooms[1], ctx2).name).toBe("Bob");
  });
});

describe("sameSet", () => {
  it("compares contents, not order", () => {
    expect(sameSet(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameSet(new Set([1]), new Set([1, 2]))).toBe(false);
    expect(sameSet(new Set([1, 3]), new Set([1, 2]))).toBe(false);
  });
});
