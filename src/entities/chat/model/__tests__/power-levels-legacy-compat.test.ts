import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests for Session 27 — admin rights / power-levels in legacy
 * bastyon-chat groups.
 *
 * Bug: groups created in the old bastyon-chat client store
 * `m.room.power_levels.users` keys with a Matrix domain that doesn't match
 * Forta's hardcoded `MATRIX_SERVER`. The previous Forta code did exact-match
 * `users[myUserId]` and silently fell back to `users_default` (0), so admins
 * lost every UI affordance: "make public", change avatar/topic, ban/kick.
 *
 * Fix: delegate to matrix-js-sdk's RoomMember.powerLevel and
 * RoomState.maySendStateEvent, which join on `m.room.member` state_key —
 * the canonical Matrix way to resolve power levels regardless of how the
 * users map was keyed at room-creation time. See
 * `.planning/bug-fix-plan/research/ADMIN-RIGHTS-LEGACY-COMPAT-RESEARCH.md`
 * for the analysis.
 *
 * These tests pin the wiring so the code can't silently regress to exact-match.
 */

const chatStoreSource = readFileSync(
  resolve(__dirname, "../chat-store.ts"),
  "utf-8",
);

const roomGuardsSource = readFileSync(
  resolve(__dirname, "../../lib/room-guards.ts"),
  "utf-8",
);

const chatInfoPanelSource = readFileSync(
  resolve(__dirname, "../../../../features/chat-info/ui/ChatInfoPanel.vue"),
  "utf-8",
);

describe("getRoomPowerLevels — uses SDK RoomMember.powerLevel for legacy compat", () => {
  it("imports getMyPowerLevel from matrix-kit", () => {
    expect(chatStoreSource).toMatch(/import\s*\{[^}]*getMyPowerLevel[^}]*\}\s*from\s*"@\/entities\/matrix\/model\/matrix-kit"/s);
  });

  it("delegates myLevel to getMyPowerLevel(matrixRoom, myUserId)", () => {
    // Locate getRoomPowerLevels body — bounded by the next named declaration
    // so we don't get fooled by `};` inside type literals.
    const startIdx = chatStoreSource.indexOf("const getRoomPowerLevels");
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = chatStoreSource.indexOf("const getMemberPowerLevelById", startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = chatStoreSource.slice(startIdx, endIdx);

    expect(block).toContain("getMyPowerLevel(matrixRoom");
    // Old exact-match must NOT come back. Allow `users` exposure for the
    // diagnostic `levels` field, but no `users[myUserId]` lookup.
    expect(block).not.toMatch(/users\[myUserId\]/);
  });
});

describe("getMemberPowerLevelById — exposed from chat-store for UI", () => {
  it("defines and exports getMemberPowerLevelById", () => {
    expect(chatStoreSource).toContain("const getMemberPowerLevelById");
    // Must appear in the store's return list (export surface).
    const returnIdx = chatStoreSource.lastIndexOf("getMemberPowerLevelById,");
    expect(returnIdx).toBeGreaterThan(-1);
  });

  it("delegates to matrix-kit's readMemberPowerLevel", () => {
    const startIdx = chatStoreSource.indexOf("const getMemberPowerLevelById");
    expect(startIdx).toBeGreaterThan(-1);
    // Bound by the next const declaration so we don't accidentally include
    // unrelated code if `};` appears inside type literals.
    const endIdx = chatStoreSource.indexOf("\n  const ", startIdx + 10);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = chatStoreSource.slice(startIdx, endIdx);

    expect(block).toContain("readMemberPowerLevel(matrixRoom");
  });
});

describe("setRoomPublic — uses SDK canSendStateEvent for permission gate", () => {
  it("imports canSendStateEvent from matrix-kit", () => {
    expect(chatStoreSource).toMatch(/import\s*\{[^}]*canSendStateEvent[^}]*\}\s*from\s*"@\/entities\/matrix\/model\/matrix-kit"/s);
  });

  it("uses canSendStateEvent on m.room.join_rules instead of self-rolled PL math", () => {
    const startIdx = chatStoreSource.indexOf("const setRoomPublic");
    expect(startIdx).toBeGreaterThan(-1);
    // Take a generous slice — the fn ends a couple of state writes later.
    const block = chatStoreSource.slice(startIdx, startIdx + 2000);

    expect(block).toContain('canSendStateEvent(matrixRoom, "m.room.join_rules"');
    // Self-rolled comparison must not come back.
    expect(block).not.toMatch(/myPl\s*<\s*requiredPl/);
    expect(block).not.toMatch(/plContent\?\.users\?\.\[myUserId\]/);
  });
});

describe("ban / kick / setMemberPowerLevel / unban — SDK-gated", () => {
  it("kickMember uses canSendStateEvent('m.room.member', myUserId)", () => {
    const startIdx = chatStoreSource.indexOf("const kickMember");
    expect(startIdx).toBeGreaterThan(-1);
    const block = chatStoreSource.slice(startIdx, startIdx + 1500);
    expect(block).toContain('canSendStateEvent(matrixRoom, "m.room.member"');
  });

  it("banMember uses canSendStateEvent('m.room.member', myUserId)", () => {
    const startIdx = chatStoreSource.indexOf("const banMember");
    expect(startIdx).toBeGreaterThan(-1);
    const block = chatStoreSource.slice(startIdx, startIdx + 1500);
    expect(block).toContain('canSendStateEvent(matrixRoom, "m.room.member"');
  });

  it("unbanMember uses canSendStateEvent('m.room.member', myUserId)", () => {
    const startIdx = chatStoreSource.indexOf("const unbanMember");
    expect(startIdx).toBeGreaterThan(-1);
    const block = chatStoreSource.slice(startIdx, startIdx + 1500);
    expect(block).toContain('canSendStateEvent(matrixRoom, "m.room.member"');
  });

  it("setMemberPowerLevel uses canSendStateEvent('m.room.power_levels', myUserId)", () => {
    const startIdx = chatStoreSource.indexOf("const setMemberPowerLevel");
    expect(startIdx).toBeGreaterThan(-1);
    const block = chatStoreSource.slice(startIdx, startIdx + 1500);
    expect(block).toContain('canSendStateEvent(matrixRoom, "m.room.power_levels"');
  });
});

describe("setRoomAvatar / setRoomTopic — SDK-gated for legacy admins", () => {
  it("setRoomAvatar uses canSendStateEvent('m.room.avatar', myUserId)", () => {
    const startIdx = chatStoreSource.indexOf("const setRoomAvatar");
    expect(startIdx).toBeGreaterThan(-1);
    const block = chatStoreSource.slice(startIdx, startIdx + 1500);
    expect(block).toContain('canSendStateEvent(matrixRoom, "m.room.avatar"');
  });

  it("setRoomTopic uses canSendStateEvent('m.room.topic', myUserId)", () => {
    const startIdx = chatStoreSource.indexOf("const setRoomTopic");
    expect(startIdx).toBeGreaterThan(-1);
    const block = chatStoreSource.slice(startIdx, startIdx + 1500);
    expect(block).toContain('canSendStateEvent(matrixRoom, "m.room.topic"');
  });
});

describe("resetPowerLevel — SDK-aware elevated check", () => {
  it("imports getMemberPowerLevel from matrix-kit", () => {
    expect(roomGuardsSource).toMatch(/import\s*\{\s*getMemberPowerLevel\s*\}\s*from\s*"@\/entities\/matrix\/model\/matrix-kit"/);
  });

  it("uses getMemberPowerLevel(matrixRoom, matrixUserId) instead of users[matrixUserId]", () => {
    const startIdx = roomGuardsSource.indexOf("export async function resetPowerLevel");
    expect(startIdx).toBeGreaterThan(-1);
    const block = roomGuardsSource.slice(startIdx);
    expect(block).toContain("getMemberPowerLevel(matrixRoom, matrixUserId)");
    expect(block).not.toMatch(/users\[matrixUserId\]/);
  });
});

describe("ChatInfoPanel — uses chat-store SDK helper for member badges", () => {
  it("calls chatStore.getMemberPowerLevelById instead of reading users map directly", () => {
    expect(chatInfoPanelSource).toContain("chatStore.getMemberPowerLevelById(");
    // The old code path read `powerLevels.value.levels[matrixId]` directly
    // for member-level — that must be gone from the helper definition.
    const helperIdx = chatInfoPanelSource.indexOf("const getMemberPowerLevel = (hexId");
    expect(helperIdx).toBeGreaterThan(-1);
    const helperBlock = chatInfoPanelSource.slice(helperIdx, helperIdx + 400);
    expect(helperBlock).not.toMatch(/powerLevels\.value\.levels\[/);
  });
});
