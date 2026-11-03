import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Samsung 2026-10-12: the first-load unread self-heal copied the SDK's cached
 * counts over Dexie before any /sync, turning a room's 1 into 0, and a cold
 * push tap opened that room without the unread banner. Source-level: the store
 * needs the SDK to run.
 */
const source = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");

describe("unread self-heal from Matrix", () => {
  it("waits for a /sync from the server and tries again later", () => {
    const heal = source.slice(source.indexOf("const syncAllUnreadFromMatrix = async"), source.indexOf("const syncAllUnreadFromMatrix = async") + 900);
    expect(heal).toMatch(/if \(!matrixService\.hasLiveSync\(\)\) \{[\s\S]*?setTimeout\([\s\S]*?syncAllUnreadFromMatrix[\s\S]*?return;/);
  });
});
