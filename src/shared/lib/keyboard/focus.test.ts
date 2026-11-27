// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/shared/lib/platform", () => ({
  isNative: true,
  isAndroid: true,
  isIOS: false,
}));

import { requestFocus, releaseFocus } from "./focus";

describe("requestFocus / releaseFocus", () => {
  let input: HTMLInputElement;

  beforeEach(() => {
    input = document.createElement("input");
    document.body.appendChild(input);
  });

  afterEach(() => {
    input.remove();
  });

  it("blocks overlay search on native even when isMobile is false", () => {
    const ok = requestFocus(input, "forward-search", { isMobile: false });
    expect(ok).toBe(false);
    expect(document.activeElement).not.toBe(input);
  });

  it("allows composer-forward-caption on native", () => {
    const ok = requestFocus(input, "composer-forward-caption", {
      isMobile: true,
    });
    expect(ok).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("releaseFocus blurs the active element", () => {
    input.focus();
    expect(document.activeElement).toBe(input);
    releaseFocus("picker", input);
    expect(document.activeElement).not.toBe(input);
  });
});
