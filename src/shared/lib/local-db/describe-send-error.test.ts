import { describe, it, expect } from "vitest";
import { describeSendError } from "./describe-send-error";

describe("describeSendError", () => {
  it("keeps Matrix errcode and HTTP status", () => {
    const e = Object.assign(new Error("Forbidden"), { errcode: "M_FORBIDDEN", httpStatus: 403 });
    expect(describeSendError(e)).toBe("M_FORBIDDEN · HTTP 403 · Forbidden");
  });

  it("falls back to data.error when message is empty", () => {
    const e = Object.assign(new Error(""), { errcode: "M_LIMIT_EXCEEDED", data: { error: "Too many requests" } });
    expect(describeSendError(e)).toBe("M_LIMIT_EXCEEDED · Too many requests");
  });

  it("prefixes non-generic error names", () => {
    const e = new TypeError("x is undefined");
    expect(describeSendError(e)).toBe("TypeError: x is undefined");
  });

  it("handles strings, nullish and opaque objects", () => {
    expect(describeSendError("plain")).toBe("plain");
    expect(describeSendError(undefined)).toBe("Unknown error");
    expect(describeSendError({})).toBe("[object Object]");
  });

  it("truncates very long messages", () => {
    const out = describeSendError(new Error("a".repeat(5000)));
    expect(out.length).toBeLessThanOrEqual(1001);
    expect(out.endsWith("…")).toBe(true);
  });
});
