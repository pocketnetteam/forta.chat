import { describe, it, expect, vi } from "vitest";
import type { ChatRoom } from "@/entities/chat";
import { createRoomNameIndex, sameSet } from "./room-name-index";

const room = (id: string, over: Partial<ChatRoom> = {}): ChatRoom =>
  ({ id, name: id, members: [`m-${id}`], isGroup: false, ...over }) as ChatRoom;

interface Ctx { names: Record<string, string> }

const setup = () => {
  const resolve = vi.fn((r: ChatRoom, ctx: Ctx) => {
    const name = ctx.names[r.members[0]];
    return { name: name ?? r.name, hasMemberNames: !!name };
  });
  return { resolve, build: createRoomNameIndex<Ctx>(resolve) };
};

describe("createRoomNameIndex", () => {
  it("resolves every room on the first build", () => {
    const { resolve, build } = setup();
    const ctx = { names: { "m-a": "Alice" } };
    const res = build([room("a"), room("b")], ctx);
    expect(res.names).toEqual({ a: "Alice", b: "b" });
    expect([...res.unresolved]).toEqual(["b"]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("re-resolves only the room whose fields changed and keeps references", () => {
    const { resolve, build } = setup();
    const ctx = { names: { "m-a": "Alice" } };
    const a = room("a");
    const b = room("b");
    const first = build([a, b], ctx);
    resolve.mockClear();

    // A receipt-style patch: new array, new object for b that keeps its member list.
    const second = build([a, { ...b, unreadCount: 3 }], ctx);
    expect(resolve).not.toHaveBeenCalled();
    expect(second).toBe(first);
    expect(second.names).toBe(first.names);
    expect(second.unresolved).toBe(first.unresolved);
  });

  it("re-resolves a room when its member list is reassigned", () => {
    const { resolve, build } = setup();
    const ctx = { names: { "m-a": "Alice", "m-x": "Xavier" } };
    const first = build([room("b")], ctx);
    resolve.mockClear();
    const second = build([room("b", { members: ["m-x"] })], ctx);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(second.names).toEqual({ b: "Xavier" });
    expect(second.unresolved.size).toBe(0);
    expect(second.unresolved).not.toBe(first.unresolved);
  });

  it("re-resolves everything when the context object changes", () => {
    const { resolve, build } = setup();
    const rooms = [room("a"), room("b")];
    build(rooms, { names: {} });
    resolve.mockClear();
    const res = build(rooms, { names: { "m-b": "Bob" } });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(res.names.b).toBe("Bob");
    expect([...res.unresolved]).toEqual(["a"]);
  });

  it("returns a new names map when a room is removed", () => {
    const { build } = setup();
    const ctx = { names: {} };
    const a = room("a");
    const first = build([a, room("b")], ctx);
    const second = build([a], ctx);
    expect(second.names).not.toBe(first.names);
    expect(second.names).toEqual({ a: "a" });
  });
});

describe("sameSet", () => {
  it("compares contents, not order", () => {
    expect(sameSet(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameSet(new Set([1]), new Set([1, 2]))).toBe(false);
    expect(sameSet(new Set([1, 3]), new Set([1, 2]))).toBe(false);
  });
});
