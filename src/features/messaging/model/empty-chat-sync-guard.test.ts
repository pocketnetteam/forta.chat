import { describe, it, expect } from "vitest";
import { shouldWaitForMatrixSyncAfterEmptyInitialLoad } from "./empty-chat-sync-guard";

describe("shouldWaitForMatrixSyncAfterEmptyInitialLoad", () => {
  it("does not wait when user cleared history", () => {
    expect(shouldWaitForMatrixSyncAfterEmptyInitialLoad(true, false)).toBe(false);
    expect(shouldWaitForMatrixSyncAfterEmptyInitialLoad(true, true)).toBe(false);
  });

  it("does not wait when timeline was already loaded (authoritative empty)", () => {
    expect(shouldWaitForMatrixSyncAfterEmptyInitialLoad(false, true)).toBe(false);
  });

  it("waits only when timeline may still fill from sync and history was not cleared", () => {
    expect(shouldWaitForMatrixSyncAfterEmptyInitialLoad(false, false)).toBe(true);
  });
});
