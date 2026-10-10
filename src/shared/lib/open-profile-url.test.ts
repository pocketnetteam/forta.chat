// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A mutable flag behind a getter, rather than `doMock` + `resetModules` +
// dynamic import. The previous version depended on the module cache being
// cleared between the parent and child `beforeEach`; when it was not, the
// import returned the module bound to the earlier platform value and the
// native cases failed intermittently in full runs while passing in isolation.
let mockIsNative = false;
vi.mock("@/shared/lib/platform", () => ({
  get isNative() {
    return mockIsNative;
  },
}));

import { openBastyonProfile } from "./open-profile-url";

describe("openBastyonProfile", () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    windowOpenSpy = vi.spyOn(window, "open").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("on native platform", () => {
    beforeEach(() => {
      mockIsNative = true;
    });

    it("calls window.open with bastyon:// URL", () => {
      openBastyonProfile("abc123");

      expect(windowOpenSpy).toHaveBeenCalledWith(
        "bastyon://user?address=abc123",
        "_blank",
        "noopener",
      );
    });

    it("encodes special characters in address", () => {
      openBastyonProfile("user@test+special");

      expect(windowOpenSpy).toHaveBeenCalledWith(
        `bastyon://user?address=${encodeURIComponent("user@test+special")}`,
        "_blank",
        "noopener",
      );
    });
  });

  describe("on web platform", () => {
    beforeEach(() => {
      mockIsNative = false;
    });

    it("calls window.open with https URL and noopener", () => {
      openBastyonProfile("abc123");

      expect(windowOpenSpy).toHaveBeenCalledWith(
        "https://bastyon.com/user?address=abc123",
        "_blank",
        "noopener",
      );
    });

    it("encodes special characters in address for web URL", () => {
      openBastyonProfile("user@test+special");

      expect(windowOpenSpy).toHaveBeenCalledWith(
        `https://bastyon.com/user?address=${encodeURIComponent("user@test+special")}`,
        "_blank",
        "noopener",
      );
    });
  });
});
