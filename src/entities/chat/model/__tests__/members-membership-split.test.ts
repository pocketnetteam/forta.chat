import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests for Session 29 — invited vs joined members in groups.
 *
 * Bug: `getRoomMembers` returns all membership states (join, invite, leave,
 * ban) intentionally for tetatet-detection, but `matrixRoomToChatRoom` then
 * mapped them flat into `room.members: string[]` without preserving membership
 * info. The UI rendered every state identically, so:
 *   1. Invited (pending) members appeared as if already joined.
 *   2. Left/banned members reappeared after the next refresh because the
 *      optimistic `room.members.filter(...)` mutation was overwritten on the
 *      next `matrixRoomToChatRoom` pass.
 *   3. The MEMBERS(N) counter (server-side joined count) didn't match the list
 *      length (all states).
 *
 * Fix: split members by `m.membership` in `matrixRoomToChatRoom`:
 *   - `join`   → `room.members`
 *   - `invite` → `room.invitedMembers`
 *   - `leave` / `ban` → excluded from both (banned tracked separately).
 * `kickMember` / `banMember` / `inviteMember` update both arrays
 * optimistically so a refresh doesn't resurrect a kicked invitee.
 *
 * See `.planning/bug-fix-plan/research/INVITED-VS-JOINED-MEMBERS-RESEARCH.md`.
 */

const chatStoreSource = readFileSync(
  resolve(__dirname, "../chat-store.ts"),
  "utf-8",
);

const typesSource = readFileSync(
  resolve(__dirname, "../types.ts"),
  "utf-8",
);

const chatInfoPanelSource = readFileSync(
  resolve(__dirname, "../../../../features/chat-info/ui/ChatInfoPanel.vue"),
  "utf-8",
);

describe("ChatRoom type — invitedMembers field", () => {
  it("declares invitedMembers as optional string array", () => {
    // Optional for backwards-compat with cached/Dexie ChatRoom records.
    expect(typesSource).toMatch(/invitedMembers\?\s*:\s*string\[\]/);
  });
});

describe("matrixRoomToChatRoom — splits members by membership", () => {
  // Locate the function body — bounded by the first `}` at column 0
  // (top-level function close), or just slice the function-scope.
  const startIdx = chatStoreSource.indexOf("function matrixRoomToChatRoom");
  const fnEndIdx = chatStoreSource.indexOf("\nexport const useChatStore", startIdx);
  const block = chatStoreSource.slice(startIdx, fnEndIdx);

  it("function exists in chat-store.ts", () => {
    expect(startIdx).toBeGreaterThan(-1);
    expect(fnEndIdx).toBeGreaterThan(startIdx);
  });

  it("does NOT flatten getRoomMembers into a flat string array via .map", () => {
    // The buggy form: `members.map((m) => getmatrixid(m.userId as string))`
    // We now iterate to split — no `.map(...).map(...)` flatten on userId only.
    expect(block).not.toMatch(/members\.map\([^)]*=>\s*getmatrixid\(m\.userId\s+as\s+string\)\)/);
  });

  it("reads m.membership when classifying each member", () => {
    expect(block).toMatch(/m\.membership/);
  });

  it("classifies into join and invite buckets", () => {
    // Both literal "join" and "invite" should appear as classification branches.
    expect(block).toMatch(/===\s*"join"/);
    expect(block).toMatch(/===\s*"invite"/);
  });

  it("returns invitedMembers in the ChatRoom object", () => {
    expect(block).toMatch(/invitedMembers\s*:/);
  });
});

describe("kickMember — optimistic remove from BOTH joined and invited", () => {
  const startIdx = chatStoreSource.indexOf("const kickMember = async");
  const endIdx = chatStoreSource.indexOf("\n  /**", startIdx + 10);
  const block = chatStoreSource.slice(startIdx, endIdx);

  it("kickMember function exists", () => {
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
  });

  it("removes from room.members", () => {
    expect(block).toMatch(/room\.members\s*=\s*room\.members\.filter/);
  });

  it("removes from room.invitedMembers as well", () => {
    expect(block).toMatch(/invitedMembers/);
    expect(block).toMatch(/room\.invitedMembers\s*=/);
  });
});

describe("banMember — optimistic remove from BOTH joined and invited", () => {
  const startIdx = chatStoreSource.indexOf("const banMember = async");
  const endIdx = chatStoreSource.indexOf("\n  /**", startIdx + 10);
  const block = chatStoreSource.slice(startIdx, endIdx);

  it("banMember function exists", () => {
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
  });

  it("removes from room.members", () => {
    expect(block).toMatch(/room\.members\s*=\s*room\.members\.filter/);
  });

  it("removes from room.invitedMembers as well", () => {
    expect(block).toMatch(/room\.invitedMembers\s*=/);
  });
});

describe("inviteMember — optimistic add to invitedMembers (not members)", () => {
  const startIdx = chatStoreSource.indexOf("const inviteMember = async");
  const endIdx = chatStoreSource.indexOf("\n  /**", startIdx + 10);
  const block = chatStoreSource.slice(startIdx, endIdx);

  it("inviteMember function exists", () => {
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
  });

  it("does NOT push hexId straight into room.members anymore", () => {
    // The buggy form: `room.members = [...room.members, hexId]` — invited
    // member was treated as joined. New behaviour writes to invitedMembers.
    expect(block).not.toMatch(/room\.members\s*=\s*\[\s*\.\.\.\s*room\.members\s*,\s*hexId\s*\]/);
  });

  it("writes the hexId to room.invitedMembers", () => {
    expect(block).toMatch(/room\.invitedMembers\s*=/);
  });
});

describe("ChatInfoPanel — renders invited members in a separate block", () => {
  it("renders v-for over room.invitedMembers", () => {
    expect(chatInfoPanelSource).toMatch(/v-for="member in [^"]*invitedMembers/);
  });

  it("uses a distinct :key prefix to avoid collisions with joined", () => {
    // Joined and invited may share hexIds across the union; render keys must
    // be disambiguated so Vue doesn't reuse the wrong DOM node.
    expect(chatInfoPanelSource).toMatch(/:key="`invite-/);
  });

  it("references the new info.invited i18n key for the badge", () => {
    expect(chatInfoPanelSource).toMatch(/t\(\s*["']info\.invited["']/);
  });
});
