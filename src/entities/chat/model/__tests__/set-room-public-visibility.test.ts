import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests for Session 28 — public group / freshly-created group
 * disappearing from sidebar.
 *
 * Bug U1-U3: Session 21 (PR #71) added a write of
 * `m.room.history_visibility = "world_readable"` whenever a room is toggled
 * public. The pre-existing sidebar filter `isStreamHistoryVisibility` treats
 * `world_readable` as a broadcast/stream marker and excludes those rooms —
 * so every newly-toggled-public group disappeared from the chat list.
 *
 * Fix: stop writing `world_readable` on public toggle; on `public→private`,
 * revert any legacy `world_readable` back to `shared` so previously-broken
 * rooms become visible again. Bastyon-chat reference (vuex/store.js:790-791)
 * confirms `world_readable` is reserved for broadcast/stream rooms only.
 *
 * These tests pin source-code wiring so the regression cannot silently come
 * back. See `.planning/bug-fix-plan/research/PUBLIC-GROUP-DISAPPEARS-FROM-SIDEBAR-RESEARCH.md`.
 */

const chatStoreSource = readFileSync(
  resolve(__dirname, "../chat-store.ts"),
  "utf-8",
);

function getSetRoomPublicBody(): string {
  const startIdx = chatStoreSource.indexOf("const setRoomPublic");
  if (startIdx < 0) throw new Error("setRoomPublic not found in chat-store.ts");
  // Function ends at the next top-level const declaration. setRoomPublic is
  // followed by joinRoomById per current layout; bound on that to be safe.
  const endIdx = chatStoreSource.indexOf("const joinRoomById", startIdx);
  if (endIdx < 0) throw new Error("joinRoomById not found after setRoomPublic");
  return chatStoreSource.slice(startIdx, endIdx);
}

describe("setRoomPublic — does NOT write world_readable on public toggle (Session 28)", () => {
  it("public branch never sends history_visibility=world_readable", () => {
    const body = getSetRoomPublicBody();

    // Locate the `if (isPublic)` branch (the public-write path) and assert
    // it does NOT contain the world_readable write that Session 21 added.
    const publicBranchIdx = body.indexOf("if (isPublic)");
    // It's OK if the branch has been removed entirely — the assertion below
    // covers that case via the negative regex over the whole body.
    if (publicBranchIdx >= 0) {
      // Extract a generous slice from `if (isPublic)` until the closing
      // brace of setRoomPublic. We just need to make sure no `world_readable`
      // string lives inside the public branch.
      const publicSlice = body.slice(publicBranchIdx);
      expect(publicSlice).not.toMatch(
        /sendStateEvent\([^)]*history_visibility[^)]*world_readable/s,
      );
    }

    // Belt + suspenders: a write payload `history_visibility: "world_readable"`
    // must not appear anywhere in the function body. The literal string is
    // only allowed inside a `currentHv === "world_readable"` comparison
    // (used to detect legacy rooms during revert).
    const writeMatches = body.match(
      /history_visibility\s*:\s*"world_readable"/g,
    );
    expect(writeMatches).toBeNull();
  });
});

describe("setRoomPublic — reverts legacy world_readable to shared on public→private (Session 28)", () => {
  it("private branch sends history_visibility=shared when current is world_readable", () => {
    const body = getSetRoomPublicBody();

    // The fix introduces a private-side branch that detects legacy
    // world_readable and reverts it to "shared" so previously-affected
    // public groups become visible again after the user toggles them
    // private then public.
    expect(body).toMatch(/if \(!isPublic\)/);
    expect(body).toMatch(/history_visibility\s*:\s*"shared"/);

    // The revert must be guarded by `currentHv === "world_readable"` so we
    // don't redundantly write `shared` when the room already has it.
    expect(body).toMatch(/currentHv\s*===\s*"world_readable"/);
  });
});

describe("setRoomPublic — preserves SDK power-level gate from Session 27", () => {
  it("still uses canSendStateEvent on m.room.join_rules", () => {
    const body = getSetRoomPublicBody();
    // Don't break legacy admin compat (Session 27).
    expect(body).toContain('canSendStateEvent(matrixRoom, "m.room.join_rules"');
  });
});
