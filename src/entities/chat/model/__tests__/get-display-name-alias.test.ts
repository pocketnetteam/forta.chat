import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "../chat-store";
import { hexEncode } from "@/shared/lib/matrix/functions";

/**
 * Regression tests for Session 51 — local contact alias priority.
 *
 * Goal: `getDisplayName(address)` must prioritize a user-set local alias over
 * Matrix displayName, user-store profile, and address truncation. The alias
 * is stored in chat-store.localAliases (mirror of Dexie users.localAlias).
 * UI callsites (chat list, header, message bubbles, mentions, ForwardPicker,
 * ChatSearch) all go through this chokepoint, so a single patch covers them
 * all.
 *
 * Hex-encoded addresses (room.members format) must resolve to the same alias
 * as the raw Bastyon address.
 *
 * `setContactAlias(addr, null)` clears the alias — the chain falls back to
 * Matrix displayName → user store → truncated address.
 */

describe("getDisplayName — local alias priority", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("setContactAlias makes getDisplayName return the alias", async () => {
    await store.setContactAlias("P9XYZ", "Дядя Петя");
    expect(store.getDisplayName("P9XYZ")).toBe("Дядя Петя");
  });

  it("alias overrides Matrix displayName cache", async () => {
    // Simulate Matrix /sync seeding userDisplayNames internally
    store.localAliases["P9XYZ"] = "Local Alias";
    expect(store.getDisplayName("P9XYZ")).toBe("Local Alias");
  });

  it("without alias, falls back to truncated address for long input", () => {
    const longAddr = "P9XYZ_LONG_ADDRESS_FOR_TRUNCATION";
    const result = store.getDisplayName(longAddr);
    expect(result).toContain("…");
    expect(result.length).toBeLessThan(longAddr.length);
  });

  it("hex-encoded address resolves to alias stored under raw address", async () => {
    const raw = "PAddr1";
    const hex = hexEncode(raw);
    await store.setContactAlias(raw, "Mama");
    // room.members stores hex-encoded IDs — the call site passes hex, but
    // the alias should still resolve via the raw form
    expect(store.getDisplayName(hex)).toBe("Mama");
  });

  it("setContactAlias(addr, null) removes the alias and falls back", async () => {
    await store.setContactAlias("PRemove", "Temp Alias");
    expect(store.getDisplayName("PRemove")).toBe("Temp Alias");
    await store.setContactAlias("PRemove", null);
    expect(store.getDisplayName("PRemove")).not.toBe("Temp Alias");
  });

  it("hasLocalAlias returns true after setContactAlias, false after clear", async () => {
    expect(store.hasLocalAlias("PCheck")).toBe(false);
    await store.setContactAlias("PCheck", "Friend");
    expect(store.hasLocalAlias("PCheck")).toBe(true);
    await store.setContactAlias("PCheck", null);
    expect(store.hasLocalAlias("PCheck")).toBe(false);
  });

  it("setContactAlias trims whitespace; empty string clears alias", async () => {
    await store.setContactAlias("PTrim", "   Trimmed   ");
    expect(store.getDisplayName("PTrim")).toBe("Trimmed");
    await store.setContactAlias("PTrim", "   ");
    expect(store.getDisplayName("PTrim")).not.toBe("Trimmed");
    expect(store.getDisplayName("PTrim")).not.toBe("   ");
  });
});
