import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { everyMemberProfileLoaded } from "../group-key-members";

/**
 * Audit S1-01 (forta-bugs#1399, #1394, #1320). A group's common key is wrapped
 * only for members whose profile (with encryption keys) is already loaded.
 * canBeEncrypt() used to accept any room with two loaded profiles, so a message
 * sent before the rest of the members loaded — right after opening the group in
 * a fresh session, or while the profile RPC was slow — published a key those
 * members could never unwrap: they saw "encrypted" for that whole key
 * generation, and the sender saw nothing wrong.
 */

describe("everyMemberProfileLoaded", () => {
  it("is false while any current member's profile is still missing", () => {
    expect(everyMemberProfileLoaded(["a", "b", "c"], { a: {}, b: {} })).toBe(false);
  });

  it("is true once every current member is loaded", () => {
    expect(everyMemberProfileLoaded(["a", "b", "c"], { a: {}, b: {}, c: {} })).toBe(true);
  });

  it("ignores loaded profiles of people who are no longer members", () => {
    expect(everyMemberProfileLoaded(["a", "b"], { a: {}, b: {}, gone: {} })).toBe(true);
  });

  it("is false for an empty member list", () => {
    expect(everyMemberProfileLoaded([], { a: {} })).toBe(false);
  });
});

describe("canBeEncrypt requires every current member to be loaded", () => {
  it("checks the current members, not only two loaded profiles, before the key check", () => {
    const source = readFileSync(resolve(__dirname, "../matrix-crypto.ts"), "utf-8");
    const start = source.indexOf("canBeEncrypt(): boolean {");
    const section = source.slice(start, source.indexOf("\n      },", start));
    const guard = section.indexOf("everyMemberProfileLoaded(");
    expect(guard).toBeGreaterThan(-1);
    expect(section).toMatch(/everyMemberProfileLoaded\(\s*getusersbytime\(0\)/);
    expect(guard).toBeLessThan(section.indexOf(".every("));
  });
});
