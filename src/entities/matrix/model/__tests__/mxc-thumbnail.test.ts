import { describe, it, expect, vi, beforeEach } from "vitest";
import { MatrixClientService } from "../matrix-client";

/**
 * WEE-71 (H1) — feed previews should pull a light server-side `/thumbnail`
 * instead of the full-size original for UNENCRYPTED images. `mxcToThumbnail`
 * forwards width/height/method to the SDK's `mxcUrlToHttp` with
 * `allowDirectLinks = true` so the homeserver downscales and re-encodes.
 */
describe("MatrixClientService.mxcToThumbnail", () => {
  let service: MatrixClientService;

  beforeEach(() => {
    service = new MatrixClientService("test.invalid");
  });

  it("returns a /thumbnail URL forwarding width/height/method", () => {
    const mxcUrlToHttp = vi.fn(
      (mxc: string, w: number, h: number, method: string) =>
        `https://hs.example/_matrix/media/v3/thumbnail/${mxc.slice(6)}?width=${w}&height=${h}&method=${method}`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = { mxcUrlToHttp };

    const url = service.mxcToThumbnail("mxc://server/abc", 400, 400, "scale");

    expect(url).toContain("/thumbnail/");
    expect(url).toContain("width=400");
    expect(url).toContain("height=400");
    expect(url).toContain("method=scale");
  });

  it("requests a thumbnail (allowDirectLinks=true) with the given args", () => {
    const mxcUrlToHttp = vi.fn(() => "https://hs.example/thumb");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = { mxcUrlToHttp };

    service.mxcToThumbnail("mxc://server/abc", 320, 240, "crop");

    expect(mxcUrlToHttp).toHaveBeenCalledWith("mxc://server/abc", 320, 240, "crop", true);
  });

  it("defaults the resize method to scale", () => {
    const mxcUrlToHttp = vi.fn(() => "https://hs.example/thumb");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = { mxcUrlToHttp };

    service.mxcToThumbnail("mxc://server/abc", 400, 400);

    expect(mxcUrlToHttp).toHaveBeenCalledWith("mxc://server/abc", 400, 400, "scale", true);
  });

  it("returns null when the client is not initialized", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = null;

    expect(service.mxcToThumbnail("mxc://server/abc", 400, 400)).toBeNull();
  });

  it("returns null when the SDK cannot resolve the URI", () => {
    const mxcUrlToHttp = vi.fn(() => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = { mxcUrlToHttp };

    expect(service.mxcToThumbnail("mxc://server/abc", 400, 400)).toBeNull();
  });
});
