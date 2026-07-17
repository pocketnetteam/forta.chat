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

  it("does not surface a raw Matrix ID stored as a profile name (forta-bugs#363/#165)", async () => {
    const { useUserStore } = await import("@/entities/user/model");
    const userStore = useUserStore();
    const addr = "PRawMatrixId";
    // A profile may carry a raw @id:domain when no human name was ever set.
    userStore.setUser(addr, { address: addr, name: "@abc123def:matrix.org", about: "", image: "", site: "", language: "" });
    const result = store.getDisplayName(addr);
    expect(result).not.toBe("@abc123def:matrix.org");
    expect(result).not.toContain("@");
  });

  it("does not surface a long hex blob stored as a profile name (forta-bugs#363/#165)", async () => {
    const { useUserStore } = await import("@/entities/user/model");
    const userStore = useUserStore();
    const addr = "PHexBlob";
    userStore.setUser(addr, { address: addr, name: "0123456789abcdef0123456789abcdef", about: "", image: "", site: "", language: "" });
    expect(store.getDisplayName(addr)).not.toBe("0123456789abcdef0123456789abcdef");
  });

  it("still surfaces short hex-like usernames (no false positives)", async () => {
    const { useUserStore } = await import("@/entities/user/model");
    const userStore = useUserStore();
    const addr = "PCafe";
    userStore.setUser(addr, { address: addr, name: "cafe", about: "", image: "", site: "", language: "" });
    expect(store.getDisplayName(addr)).toBe("cafe");
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

  it("clear via raw form clears alias set via hex form (H1 regression)", async () => {
    // Bug class: dual-key (hex+raw) cache layout left stale entries when the
    // user set via group panel (hex) and cleared via DM panel (raw) or vice
    // versa. Aliases must canonicalize to raw form regardless of input shape.
    const raw = "PCrossForm";
    const hex = hexEncode(raw);
    await store.setContactAlias(hex, "Cousin");
    expect(store.getDisplayName(hex)).toBe("Cousin");
    expect(store.getDisplayName(raw)).toBe("Cousin");
    await store.setContactAlias(raw, null);
    expect(store.getDisplayName(hex)).not.toBe("Cousin");
    expect(store.getDisplayName(raw)).not.toBe("Cousin");
    expect(store.hasLocalAlias(hex)).toBe(false);
    expect(store.hasLocalAlias(raw)).toBe(false);
  });
});

/**
 * WEE-39 follow-up regression: `getCanonicalDisplayName` MUST skip the
 * local-alias step. It is the chokepoint for any name that will leave the
 * device (outbound @mention safeName, forward attribution, etc.). If it
 * accidentally returned the alias, recipients would see a stranger string
 * because they do not share the sender's private address book.
 */
describe("getCanonicalDisplayName — alias must not leak to wire", () => {
  let store: ReturnType<typeof useChatStore>;
  let userStore: ReturnType<typeof import("@/entities/user/model").useUserStore>;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    const { useUserStore } = await import("@/entities/user/model");
    userStore = useUserStore();
  });

  function seedCanonical(address: string, name: string): void {
    userStore.setUser(address, {
      address,
      name,
      about: "",
      image: "",
      site: "",
      language: "",
    });
  }

  it("ignores localAlias and falls back to canonical chain", async () => {
    await store.setContactAlias("PAlias", "qqq");
    // Sanity: getDisplayName returns the alias (private UX).
    expect(store.getDisplayName("PAlias")).toBe("qqq");
    // Canonical lookup must skip the alias and fall back to truncation
    // (no user-store profile seeded for this address).
    expect(store.getCanonicalDisplayName("PAlias")).not.toBe("qqq");
  });

  it("returns user-store profile name when one is cached (no alias leak)", async () => {
    await store.setContactAlias("PCached", "qqq");
    seedCanonical("PCached", "dqwewr");
    expect(store.getDisplayName("PCached")).toBe("qqq");
    expect(store.getCanonicalDisplayName("PCached")).toBe("dqwewr");
  });

  it("resolves hex-encoded address through canonical chain", async () => {
    const raw = "PHexCanonical";
    const hex = hexEncode(raw);
    await store.setContactAlias(raw, "MyLocal");
    seedCanonical(raw, "Real Name");
    expect(store.getDisplayName(hex)).toBe("MyLocal");
    expect(store.getCanonicalDisplayName(hex)).toBe("Real Name");
  });

  it("returns '?' for empty input", () => {
    expect(store.getCanonicalDisplayName("")).toBe("?");
  });
});
