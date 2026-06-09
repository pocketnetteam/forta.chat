import { describe, it, expect } from "vitest";
import {
  isValidUsername,
  validateUsername,
  USERNAME_MAX_LENGTH,
} from "../username-validation";

/**
 * WEE-78 regression: Forta username validation must match Bastyon name rules
 * so an account created in Forta is always accepted by Bastyon.
 *
 * The old regex (`/^[a-zA-Z0-9 .\-_@#&]+$/`) allowed `@ # &`, hyphen and spaces
 * — all forbidden by Bastyon (bug reports #418/#947/#417) — producing accounts
 * that could not log into Bastyon. If this test fails, that incompatibility is
 * back.
 */
describe("username-validation (Bastyon parity)", () => {
  it("rejects @ # & and spaces (Bastyon parity)", () => {
    expect(isValidUsername("john@doe")).toBe(false);
    expect(isValidUsername("a b")).toBe(false);
    expect(isValidUsername("john_doe.1")).toBe(true);
  });

  it("rejects every Bastyon-forbidden character", () => {
    expect(isValidUsername("john#doe")).toBe(false);
    expect(isValidUsername("john&doe")).toBe(false);
    expect(isValidUsername("john-doe")).toBe(false); // hyphen is forbidden in Bastyon (#418)
    expect(isValidUsername("john doe")).toBe(false);
    expect(isValidUsername("имя")).toBe(false); // cyrillic — rejected by blockchain
  });

  it("accepts the Bastyon-compatible character set", () => {
    expect(isValidUsername("john")).toBe(true);
    expect(isValidUsername("John_Doe")).toBe(true);
    expect(isValidUsername("user.name_42")).toBe(true);
    expect(isValidUsername("ABC123")).toBe(true);
  });

  it("treats empty / whitespace-only as valid (handled by required field)", () => {
    expect(isValidUsername("")).toBe(true);
    expect(isValidUsername("   ")).toBe(true);
  });

  it("flags names longer than the max length", () => {
    const tooLong = "a".repeat(USERNAME_MAX_LENGTH + 1);
    expect(isValidUsername(tooLong)).toBe(false);
    expect(validateUsername(tooLong)).toEqual({
      code: "tooLong",
      max: USERNAME_MAX_LENGTH,
    });
  });

  it("returns a structured error code for invalid characters", () => {
    expect(validateUsername("john@doe")).toEqual({ code: "invalidChars" });
  });

  it("blocks reserved names regardless of separators or case", () => {
    expect(validateUsername("bastyon")).toEqual({ code: "reserved", name: "bastyon" });
    expect(validateUsername("Pocketnet")).toEqual({ code: "reserved", name: "pocketnet" });
    expect(validateUsername("b.a.s.t.y.o.n")).toEqual({ code: "reserved", name: "bastyon" });
  });
});
