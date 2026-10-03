import { describe, it, expect } from "vitest";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { KEYS_MAX_MEMBERS, roomAddresses, roomsKeyAddresses } from "./room-addresses";

const ME = "PMeAddress111";
const PEER = "PPeerAddress22";
const OTHER = "POtherAddress3";
const hex = (a: string) => hexEncode(a).toLowerCase();
const b64Json = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

describe("roomAddresses", () => {
  it("does not stop at an SDK list that holds only the own user (lazy-loaded members)", () => {
    expect(roomAddresses({ sdkAddresses: [ME], memberHexIds: [hex(ME), hex(PEER)] }).sort()).toEqual([ME, PEER].sort());
  });

  it("adds senders and Pcrypto recipients of live events", () => {
    const own = { sender: `@${hex(ME)}:s`, content: { msgtype: "m.encrypted", body: b64Json({ [hex(ME)]: 1, [hex(PEER)]: 1 }) } };
    const fromOther = { sender: `@${hex(OTHER)}:s`, content: { msgtype: "m.text", body: "hi" } };
    expect(roomAddresses({ sdkAddresses: [ME], events: [own, fromOther] }).sort()).toEqual([ME, PEER, OTHER].sort());
  });

  it("returns [] when nothing is known", () => {
    expect(roomAddresses({})).toEqual([]);
  });
});

describe("roomsKeyAddresses", () => {
  it("merges the rooms' participants without the own address", () => {
    const rooms = [
      { addresses: [ME, PEER], joinedCount: 2 },
      { addresses: [ME, OTHER, PEER], joinedCount: 3 },
    ];
    expect(roomsKeyAddresses(rooms, ME).sort()).toEqual([PEER, OTHER].sort());
  });

  it("skips a large group by the server's count even when few members are known", () => {
    const rooms = [{ addresses: [ME, PEER], joinedCount: KEYS_MAX_MEMBERS }];
    expect(roomsKeyAddresses(rooms, ME)).toEqual([]);
  });

  it("skips a room with that many known participants when the count is unknown", () => {
    const many = Array.from({ length: KEYS_MAX_MEMBERS }, (_, i) => `PAddr${i}`);
    expect(roomsKeyAddresses([{ addresses: many, joinedCount: 0 }], ME)).toEqual([]);
  });
});
