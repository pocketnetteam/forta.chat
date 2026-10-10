import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = () =>
  readFileSync(resolve(__dirname, "../ChatSidebar.vue"), "utf-8");

describe("ChatSidebar invite FAB", () => {
  // Regression: an infinite box-shadow pulse on the always-visible invite
  // button forced a Paint + Layerize every frame while the app sat idle.
  it("has no infinite animation on the always-visible invite button", () => {
    const rule = source().match(/\.invite-fab\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).not.toMatch(/animation/);
    expect(source()).not.toMatch(/@keyframes\s+invite-pulse/);
  });
});
