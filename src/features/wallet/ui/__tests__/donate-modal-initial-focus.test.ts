import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("DonateModal — keyboard initial focus", () => {
  it("opts into first-focusable so the amount field can open the IME on mobile", () => {
    const src = readFileSync(resolve(__dirname, "../DonateModal.vue"), "utf-8");
    expect(src).toMatch(/initial-focus=["']first-focusable["']/);
  });
});
