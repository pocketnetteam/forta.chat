import { describe, it, expect } from "vitest";
import { isEmptyUserProfile } from "../is-empty-profile";

describe("isEmptyUserProfile", () => {
  it("treats null/undefined as empty", () => {
    expect(isEmptyUserProfile(null)).toBe(true);
    expect(isEmptyUserProfile(undefined)).toBe(true);
  });

  it("treats missing/blank name as empty", () => {
    expect(isEmptyUserProfile({ name: "" })).toBe(true);
    expect(isEmptyUserProfile({ name: "   " })).toBe(true);
    expect(isEmptyUserProfile({})).toBe(true);
  });

  it("treats a real name as non-empty", () => {
    expect(isEmptyUserProfile({ name: "Alice" })).toBe(false);
  });
});
