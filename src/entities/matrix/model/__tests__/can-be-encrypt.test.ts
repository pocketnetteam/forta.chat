import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = () => readFileSync(resolve(__dirname, "../matrix-crypto.ts"), "utf-8");

describe("canBeEncrypt peer key check", () => {
  it("should check that all usersinfo entries have >= m keys using .every()", () => {
    const source = getSource();
    const start = source.indexOf("canBeEncrypt(): boolean {");
    expect(start).toBeGreaterThan(-1);
    const section = source.slice(start, start + 800);
    expect(section).toContain(".every(");
    expect(section).toContain("keys.length >= m");
  });

  it("should not only check usersinfo.length without key verification", () => {
    const source = getSource();
    const start = source.indexOf("canBeEncrypt(): boolean {");
    expect(start).toBeGreaterThan(-1);
    const section = source.slice(start, start + 800);
    // Should NOT have the old pattern: just return length > 1 && length < 50
    expect(section).not.toMatch(/return usersinfoArray\.length > 1 && usersinfoArray\.length < 50;/);
  });
});

describe("decrypt graceful degradation", () => {
  it("decryptEvent should check for missing body entries", () => {
    const source = getSource();
    const start = source.indexOf("async decryptEvent(event");
    const section = source.slice(start, start + 4000);
    expect(section).toContain("no encrypted payload for");
  });

  it("encryptEvent should warn when members missing keys", () => {
    const source = getSource();
    const start = source.indexOf("async encryptEvent(text");
    const section = source.slice(start, start + 1000);
    expect(section).toContain("missing encryption keys");
  });
});
