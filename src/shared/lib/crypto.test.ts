import { describe, it, expect } from "vitest";
import { generateDeviceId } from "./crypto";

describe("generateDeviceId", () => {
  it("returns a 32-character hex string", () => {
    const id = generateDeviceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates different IDs on successive calls", () => {
    const id1 = generateDeviceId();
    const id2 = generateDeviceId();
    expect(id1).not.toBe(id2);
  });

  it("has exactly 32 characters (16 bytes)", () => {
    expect(generateDeviceId().length).toBe(32);
  });

  it("only contains lowercase hex characters", () => {
    for (let i = 0; i < 10; i++) {
      expect(generateDeviceId()).toMatch(/^[0-9a-f]+$/);
    }
  });
});
