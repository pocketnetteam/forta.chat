import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isLiveSync } from "../matrix-client";

/**
 * Samsung 2026-10-12: a cold push tap opened the chat without the unread
 * banner. The first-load unread self-heal copied the SDK's counts over Dexie
 * while the SDK held only its cached state, older than Dexie: the room's 1
 * became 0 just before the tap opened it. The heal now waits for a /sync from
 * the server; the client says when one has completed.
 */
describe("isLiveSync", () => {
  it("is false for a PREPARED replayed from the local store", () => {
    expect(isLiveSync("PREPARED", true)).toBe(false);
  });

  it("is true for a PREPARED from the server and for every SYNCING", () => {
    expect(isLiveSync("PREPARED", false)).toBe(true);
    expect(isLiveSync("SYNCING", false)).toBe(true);
  });

  it("is false for error states", () => {
    expect(isLiveSync("ERROR", false)).toBe(false);
    expect(isLiveSync("RECONNECTING", false)).toBe(false);
  });
});

describe("matrix-client live sync flag (source)", () => {
  const source = readFileSync(resolve(__dirname, "../matrix-client.ts"), "utf-8");

  it("sets the flag from the sync handler and resets it with each new client", () => {
    const handler = source.slice(source.indexOf('this.client.on("sync",'), source.indexOf('this.client.on("sync",') + 400);
    expect(handler).toContain("if (isLiveSync(state, data?.fromCache === true)) this.liveSyncSeen = true;");
    const build = source.slice(source.indexOf("this.client = userClient;") - 200, source.indexOf("this.client = userClient;") + 60);
    expect(build).toContain("this.liveSyncSeen = false;");
    expect(source).toMatch(/hasLiveSync\(\): boolean \{\s*return this\.liveSyncSeen;/);
  });
});
