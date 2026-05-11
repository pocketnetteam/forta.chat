import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncProfileToMatrix, type MatrixProfileSync } from "../sync-profile-to-matrix";

/**
 * Behavioral tests for syncProfileToMatrix — best-effort Matrix profile sync
 * after a successful Pocketnet blockchain edit (Session 45).
 *
 * Closes #595, #591, #375, #368, #121: peers must see the user's chosen
 * nickname + avatar instead of a truncated wallet address.
 */
describe("syncProfileToMatrix", () => {
  let setDisplayName: ReturnType<typeof vi.fn>;
  let uploadAvatar: ReturnType<typeof vi.fn>;
  let setAvatarMxc: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setDisplayName = vi.fn().mockResolvedValue(undefined);
    uploadAvatar = vi.fn().mockResolvedValue("mxc://server/abc");
    setAvatarMxc = vi.fn().mockResolvedValue(undefined);
    originalFetch = globalThis.fetch;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  const matrix = (): MatrixProfileSync => ({ setDisplayName, uploadAvatar, setAvatarMxc }) as unknown as MatrixProfileSync;

  it("calls setDisplayName when a name is provided", async () => {
    await syncProfileToMatrix(matrix(), { name: "Alice" });

    expect(setDisplayName).toHaveBeenCalledTimes(1);
    expect(setDisplayName).toHaveBeenCalledWith("Alice");
  });

  it("calls setDisplayName('') when name is explicitly cleared", async () => {
    // user removed their nickname; peers must see it cleared in Matrix too
    await syncProfileToMatrix(matrix(), { name: "" });

    expect(setDisplayName).toHaveBeenCalledTimes(1);
    expect(setDisplayName).toHaveBeenCalledWith("");
  });

  it("skips setDisplayName when name field was not provided at all", async () => {
    await syncProfileToMatrix(matrix(), {});

    expect(setDisplayName).not.toHaveBeenCalled();
  });

  it("fetches the avatar URL, uploads the blob, and writes mxc to profile", async () => {
    const blob = new Blob(["fake-png-bytes"], { type: "image/png" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(blob),
    }) as unknown as typeof fetch;

    await syncProfileToMatrix(matrix(), { image: "https://cdn/avatar.png" });

    expect(globalThis.fetch).toHaveBeenCalledWith("https://cdn/avatar.png");
    expect(uploadAvatar).toHaveBeenCalledTimes(1);
    expect(uploadAvatar).toHaveBeenCalledWith(blob);
    expect(setAvatarMxc).toHaveBeenCalledTimes(1);
    expect(setAvatarMxc).toHaveBeenCalledWith("mxc://server/abc");
  });

  it("skips avatar upload when blob exceeds 5 MB Matrix limit", async () => {
    const oversize = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(oversize),
    }) as unknown as typeof fetch;

    await syncProfileToMatrix(matrix(), { image: "https://cdn/large.png" });

    expect(uploadAvatar).not.toHaveBeenCalled();
    expect(setAvatarMxc).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("uploads avatar up to 5 MB Matrix limit", async () => {
    const atLimit = new Blob([new Uint8Array(5 * 1024 * 1024)], { type: "image/png" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(atLimit),
    }) as unknown as typeof fetch;

    await syncProfileToMatrix(matrix(), { image: "https://cdn/atlimit.png" });

    expect(uploadAvatar).toHaveBeenCalledTimes(1);
  });

  it("swallows avatar fetch errors so Pocketnet save still succeeds", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    await expect(
      syncProfileToMatrix(matrix(), { image: "https://cdn/x.png" }),
    ).resolves.toBeUndefined();
    expect(uploadAvatar).not.toHaveBeenCalled();
    expect(setAvatarMxc).not.toHaveBeenCalled();
  });

  it("swallows non-2xx fetch responses without uploading", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      blob: () => Promise.resolve(new Blob()),
    }) as unknown as typeof fetch;

    await syncProfileToMatrix(matrix(), { image: "https://cdn/missing.png" });

    expect(uploadAvatar).not.toHaveBeenCalled();
    expect(setAvatarMxc).not.toHaveBeenCalled();
  });

  it("clears avatar via setAvatarMxc('') when image is explicitly empty", async () => {
    // user removed their avatar; peers must see it cleared in Matrix too
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await syncProfileToMatrix(matrix(), { image: "" });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(uploadAvatar).not.toHaveBeenCalled();
    expect(setAvatarMxc).toHaveBeenCalledTimes(1);
    expect(setAvatarMxc).toHaveBeenCalledWith("");
  });

  it("skips avatar entirely when image field was not provided", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await syncProfileToMatrix(matrix(), { name: "Alice" });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(uploadAvatar).not.toHaveBeenCalled();
    expect(setAvatarMxc).not.toHaveBeenCalled();
  });

  it("syncs both name and avatar when both are provided", async () => {
    const blob = new Blob(["x"], { type: "image/jpeg" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(blob),
    }) as unknown as typeof fetch;

    await syncProfileToMatrix(matrix(), { name: "Bob", image: "https://cdn/b.jpg" });

    expect(setDisplayName).toHaveBeenCalledWith("Bob");
    expect(uploadAvatar).toHaveBeenCalledWith(blob);
    expect(setAvatarMxc).toHaveBeenCalledWith("mxc://server/abc");
  });
});
