import { describe, it, expect } from "vitest";
import { makeRoom, makeMsg } from "@/test-utils";
import { hasDisplayableContent, filterRoomsForTab } from "./room-visibility";
import type { ChatRoom } from "@/entities/chat/model/types";

describe("hasDisplayableContent", () => {
  it("returns true when room has a lastMessage", () => {
    const room = makeRoom({ lastMessage: makeMsg({ timestamp: 100 }), name: "", updatedAt: 0 });
    expect(hasDisplayableContent(room)).toBe(true);
  });

  it("returns true when room has updatedAt > 0 (even without name or message)", () => {
    const room = makeRoom({ name: "", lastMessage: undefined, updatedAt: 1_700_000_000_000 });
    expect(hasDisplayableContent(room)).toBe(true);
  });

  it("returns true when room has a real name (no message, no updatedAt)", () => {
    const room = makeRoom({ name: "Work chat", lastMessage: undefined, updatedAt: 0 });
    expect(hasDisplayableContent(room)).toBe(true);
  });

  it("returns true for a Matrix-ID-like name (unresolved but still renderable)", () => {
    // Unresolved names render as skeletons — they should not be filtered out.
    const room = makeRoom({ name: "!abc:server", lastMessage: undefined, updatedAt: 0 });
    expect(hasDisplayableContent(room)).toBe(true);
  });

  it('returns false when name="-" and no message and no updatedAt (empty placeholder)', () => {
    const room = makeRoom({ name: "-", lastMessage: undefined, updatedAt: 0 });
    expect(hasDisplayableContent(room)).toBe(false);
  });

  it("returns false when name is empty and no message and no updatedAt", () => {
    const room = makeRoom({ name: "", lastMessage: undefined, updatedAt: 0 });
    expect(hasDisplayableContent(room)).toBe(false);
  });

  it("returns false when name is whitespace and no message and no updatedAt", () => {
    const room = makeRoom({ name: "   ", lastMessage: undefined, updatedAt: 0 });
    expect(hasDisplayableContent(room)).toBe(false);
  });

  it("returns true for an invite with updatedAt set", () => {
    const room = makeRoom({ membership: "invite", name: "-", lastMessage: undefined, updatedAt: 1_700_000_000_000 });
    expect(hasDisplayableContent(room)).toBe(true);
  });

  it('returns true when updatedAt > 0 even if name="-" (updatedAt short-circuits)', () => {
    // This locks the current semantics: `updatedAt` is a strong enough signal on its own.
    // `filterRoomsForTab` is what actually excludes invite placeholders from the "all" tab.
    const room = makeRoom({ name: "-", lastMessage: undefined, updatedAt: 1_700_000_000_000 });
    expect(hasDisplayableContent(room)).toBe(true);
  });
});

describe("filterRoomsForTab", () => {
  const joined1 = makeRoom({ id: "!j1:s", membership: "join", isGroup: false, name: "Alice", lastMessage: makeMsg({ timestamp: 100 }) });
  const joined2 = makeRoom({ id: "!j2:s", membership: "join", isGroup: true, name: "Team", lastMessage: makeMsg({ timestamp: 200 }) });
  const joinedEmpty = makeRoom({ id: "!je:s", membership: "join", isGroup: false, name: "-", lastMessage: undefined, updatedAt: 0 });
  const invite1 = makeRoom({ id: "!i1:s", membership: "invite", isGroup: false, name: "Invite1", lastMessage: undefined, updatedAt: 1000 });
  const inviteEmpty = makeRoom({ id: "!ie:s", membership: "invite", isGroup: false, name: "-", lastMessage: undefined, updatedAt: 0 });

  const all: ChatRoom[] = [joined1, joined2, joinedEmpty, invite1, inviteEmpty];

  // WEE-59: pending invites must surface in the "all" tab alongside joined rooms
  // so the user does not miss them. Only empty placeholder rooms stay hidden.
  it('"all" tab shows joined rooms AND pending invites, hides only empty placeholders', () => {
    const filtered = filterRoomsForTab(all, "all");
    expect(filtered.map(r => r.id)).toEqual(["!j1:s", "!j2:s", "!i1:s"]);
  });

  it('"all" tab still drops un-hydrated empty invites (no blank stripes)', () => {
    const filtered = filterRoomsForTab(all, "all");
    expect(filtered.map(r => r.id)).not.toContain("!ie:s");
  });

  it('"all" tab shows both DM and group invites (WEE-59 A6)', () => {
    const dmInvite = makeRoom({ id: "!dm:s", membership: "invite", isGroup: false, name: "DM Invite", lastMessage: undefined, updatedAt: 1000 });
    const groupInvite = makeRoom({ id: "!gi:s", membership: "invite", isGroup: true, name: "Group Invite", lastMessage: undefined, updatedAt: 2000 });
    const filtered = filterRoomsForTab([joined1, dmInvite, groupInvite], "all");
    expect(filtered.map(r => r.id)).toEqual(["!j1:s", "!dm:s", "!gi:s"]);
  });

  it('"personal" tab keeps joined membership only (invites live in "all" + Invites tab)', () => {
    const filtered = filterRoomsForTab(all, "personal");
    expect(filtered.map(r => r.id)).toEqual(["!j1:s"]);
  });

  it('"groups" tab keeps joined groups only (invites excluded)', () => {
    const filtered = filterRoomsForTab(all, "groups");
    expect(filtered.map(r => r.id)).toEqual(["!j2:s"]);
  });

  it('"invites" tab keeps ALL invites (even empty ones — user needs to accept/decline)', () => {
    const filtered = filterRoomsForTab(all, "invites");
    expect(filtered.map(r => r.id).sort()).toEqual(["!i1:s", "!ie:s"]);
  });

  it("preserves input order (does not sort)", () => {
    const a = makeRoom({ id: "!a:s", lastMessage: makeMsg({ timestamp: 100 }) });
    const b = makeRoom({ id: "!b:s", lastMessage: makeMsg({ timestamp: 200 }) });
    const c = makeRoom({ id: "!c:s", lastMessage: makeMsg({ timestamp: 50 }) });
    expect(filterRoomsForTab([a, b, c], "all").map(r => r.id)).toEqual(["!a:s", "!b:s", "!c:s"]);
  });
});
