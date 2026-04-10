import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @/shared/lib/platform before importing the module under test
vi.mock("@/shared/lib/platform", () => ({
  isNative: false,
}));

describe("openBastyonProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("on native platform", () => {
    beforeEach(() => {
      vi.doMock("@/shared/lib/platform", () => ({ isNative: true }));
    });

    it("calls window.open with bastyon:// URL", async () => {
      const windowOpenSpy = vi.spyOn(window, "open").mockReturnValue(null);
      const { openBastyonProfile } = await import("./open-profile-url");
      openBastyonProfile("abc123");
      expect(windowOpenSpy).toHaveBeenCalledWith(
        "bastyon://user?address=abc123",
        "_blank",
        "noopener"
      );
      windowOpenSpy.mockRestore();
    });

    it("encodes special characters in address", async () => {
      const windowOpenSpy = vi.spyOn(window, "open").mockReturnValue(null);
      const { openBastyonProfile } = await import("./open-profile-url");
      openBastyonProfile("user@test+special");
      expect(windowOpenSpy).toHaveBeenCalledWith(
        `bastyon://user?address=${encodeURIComponent("user@test+special")}`,
        "_blank",
        "noopener"
      );
      windowOpenSpy.mockRestore();
    });
  });

  describe("on web platform", () => {
    beforeEach(() => {
      vi.doMock("@/shared/lib/platform", () => ({ isNative: false }));
    });

    it("calls window.open with https URL and noopener", async () => {
      const windowOpenSpy = vi.spyOn(window, "open").mockReturnValue(null);
      const { openBastyonProfile } = await import("./open-profile-url");
      openBastyonProfile("abc123");
      expect(windowOpenSpy).toHaveBeenCalledWith(
        "https://bastyon.com/user?address=abc123",
        "_blank",
        "noopener"
      );
      windowOpenSpy.mockRestore();
    });

    it("encodes special characters in address for web URL", async () => {
      const windowOpenSpy = vi.spyOn(window, "open").mockReturnValue(null);
      const { openBastyonProfile } = await import("./open-profile-url");
      openBastyonProfile("user@test+special");
      expect(windowOpenSpy).toHaveBeenCalledWith(
        `https://bastyon.com/user?address=${encodeURIComponent("user@test+special")}`,
        "_blank",
        "noopener"
      );
      windowOpenSpy.mockRestore();
    });
  });
});
