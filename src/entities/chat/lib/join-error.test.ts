import { describe, it, expect } from "vitest";
import { categorizeJoinError, validateRoomId } from "./join-error";

// Identity translation function so we can assert the exact i18n key the
// implementation picked without pulling the full vue-i18n setup.
const identityT = (key: string): string => key;

describe("validateRoomId", () => {
  it("accepts a well-formed Matrix room id", () => {
    expect(validateRoomId("!abc:matrix.org")).toBe(true);
    expect(validateRoomId("!room_id.with-dashes=foo+bar:server")).toBe(true);
    expect(validateRoomId("!room:server:8448")).toBe(true);
  });

  it("rejects empty / non-string / malformed ids", () => {
    expect(validateRoomId("")).toBe(false);
    expect(validateRoomId("roomid")).toBe(false); // no leading !
    expect(validateRoomId("!missing-colon")).toBe(false);
    expect(validateRoomId("!bad/traversal:server")).toBe(false); // `/` is not allowed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validateRoomId(undefined as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validateRoomId(null as any)).toBe(false);
  });
});

describe("categorizeJoinError", () => {
  it("classifies M_FORBIDDEN as 'forbidden' (private room)", () => {
    const r = categorizeJoinError({ errcode: "M_FORBIDDEN", message: "Not invited" }, identityT);
    expect(r).toEqual({
      ok: false,
      reason: "forbidden",
      errorMessage: "joinRoom.errorForbidden",
    });
  });

  it("classifies M_NOT_FOUND as 'not_found'", () => {
    const r = categorizeJoinError({ errcode: "M_NOT_FOUND" }, identityT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("not_found");
      expect(r.errorMessage).toBe("joinRoom.errorNotFound");
    }
  });

  it("reads errcode from nested data (matrix-js-sdk shape)", () => {
    const r = categorizeJoinError({ data: { errcode: "M_FORBIDDEN" } }, identityT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("forbidden");
  });

  it("falls back to 'unknown' for generic errors", () => {
    const r = categorizeJoinError(new Error("network"), identityT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown");
      // network message bubbles up verbatim so the user sees the real failure
      expect(r.errorMessage).toBe("network");
    }
  });

  it("uses translated default when error has no message", () => {
    const r = categorizeJoinError({}, identityT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown");
      expect(r.errorMessage).toBe("joinRoom.errorUnknown");
    }
  });
});
