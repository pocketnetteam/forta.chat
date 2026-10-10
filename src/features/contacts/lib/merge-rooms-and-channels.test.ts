import { describe, it, expect } from "vitest";
import type { ChatRoom } from "@/entities/chat";
import type { Channel } from "@/entities/channel";
import { mergeRoomsAndChannels } from "./merge-rooms-and-channels";

const room = (id: string, ts: number, over: Partial<ChatRoom> = {}): ChatRoom =>
  ({ id, updatedAt: ts, lastMessage: { timestamp: ts }, ...over }) as unknown as ChatRoom;
const channel = (address: string, ts: number): Channel =>
  ({ address, lastContent: { time: ts / 1000 } }) as unknown as Channel;

const keys = (items: (ChatRoom | Channel)[]) =>
  items.map(i => ("id" in i ? i.id : `ch:${(i as Channel).address}`));

describe("mergeRoomsAndChannels", () => {
  it("interleaves rooms and channels by time, newest first", () => {
    const rooms = [room("a", 5000), room("b", 2000)];
    const channels = [channel("x", 1000), channel("y", 3000)];
    expect(keys(mergeRoomsAndChannels(rooms, channels))).toEqual(["a", "ch:y", "b", "ch:x"]);
  });

  it("keeps the upstream room order and puts rooms before channels at equal time", () => {
    const rooms = [room("a", 2000), room("b", 2000, { membership: "invite" })];
    expect(keys(mergeRoomsAndChannels(rooms, [channel("x", 2000)]))).toEqual(["a", "b", "ch:x"]);
  });

  it("does not reorder the store's channel array", () => {
    const channels = [channel("x", 1000), channel("y", 3000)];
    mergeRoomsAndChannels([], channels);
    expect(keys(channels)).toEqual(["ch:x", "ch:y"]);
  });
});
