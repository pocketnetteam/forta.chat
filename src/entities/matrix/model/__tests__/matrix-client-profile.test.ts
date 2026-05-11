import { describe, it, expect, vi, beforeEach } from "vitest";
import { MatrixClientService } from "../matrix-client";

/**
 * Tests for Matrix profile setter API on MatrixClientService.
 *
 * Closes Session 45 issues #595, #591, #375, #368, #121: forta.chat must call
 * setDisplayName / setAvatarUrl after Pocketnet edit so peers see the user's
 * nickname + avatar instead of a truncated wallet address.
 */
describe("MatrixClientService profile API", () => {
  let service: MatrixClientService;

  beforeEach(() => {
    service = new MatrixClientService("test.invalid");
  });

  describe("setDisplayName", () => {
    it("forwards name to underlying client.setDisplayName", async () => {
      const setDisplayName = vi.fn().mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).client = { setDisplayName };

      await service.setDisplayName("Alice");

      expect(setDisplayName).toHaveBeenCalledTimes(1);
      expect(setDisplayName).toHaveBeenCalledWith("Alice");
    });

    it("throws when client is not initialized", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).client = null;

      await expect(service.setDisplayName("Alice")).rejects.toThrow();
    });
  });

  describe("uploadAvatar", () => {
    it("uploads blob via client.uploadContent and returns mxc URI", async () => {
      const uploadContent = vi.fn().mockResolvedValue({ content_uri: "mxc://server/abc" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).client = { uploadContent };

      const blob = new Blob(["x"], { type: "image/png" });
      const url = await service.uploadAvatar(blob);

      expect(url).toBe("mxc://server/abc");
      expect(uploadContent).toHaveBeenCalledTimes(1);
      const [uploadedBlob, opts] = uploadContent.mock.calls[0];
      expect(uploadedBlob).toBe(blob);
      expect(opts).toMatchObject({ type: "image/png" });
    });

    it("throws when client is not initialized", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).client = null;

      const blob = new Blob(["x"], { type: "image/png" });
      await expect(service.uploadAvatar(blob)).rejects.toThrow();
    });
  });

  describe("setAvatarMxc", () => {
    it("forwards mxc URL to underlying client.setAvatarUrl", async () => {
      const setAvatarUrl = vi.fn().mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).client = { setAvatarUrl };

      await service.setAvatarMxc("mxc://server/abc");

      expect(setAvatarUrl).toHaveBeenCalledTimes(1);
      expect(setAvatarUrl).toHaveBeenCalledWith("mxc://server/abc");
    });

    it("throws when client is not initialized", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).client = null;

      await expect(service.setAvatarMxc("mxc://abc")).rejects.toThrow();
    });
  });
});
