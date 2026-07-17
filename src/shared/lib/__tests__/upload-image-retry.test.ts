import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * WEE-51 / forta-bugs#803, #747 — Avatar (and any image) upload used to
 * surface "Failed to fetch" on the first transient network glitch. The
 * uploader now retries up to 3 attempts for fetch TypeErrors and HTTP 5xx,
 * but must NOT retry on 4xx (user-correctable) or on a successful response
 * with no `ident` (server contract violation — retrying won't help).
 */

const UPLOAD_URL = "https://pocketnet.app:8092/up";
const IMAGE_BASE_URL = "https://pocketnet.app:8092/i/";

function jsonOk(ident = "abc123"): Response {
  return new Response(JSON.stringify({ success: true, data: { ident } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function http(status: number, body: unknown = { error: "boom" }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("uploadImage — transient failure retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns the image URL on the first successful attempt without delay", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonOk("first"));
    vi.stubGlobal("fetch", fetchMock);
    const { uploadImage } = await import("../upload-image");

    const url = await uploadImage("data:image/jpeg;base64,AAAA");

    expect(url).toBe(`${IMAGE_BASE_URL}first`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(UPLOAD_URL, expect.any(Object));
  });

  it("retries on fetch TypeError (the browser's 'Failed to fetch') and eventually succeeds", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonOk("recovered"));
    vi.stubGlobal("fetch", fetchMock);
    const { uploadImage } = await import("../upload-image");

    const promise = uploadImage("data:image/jpeg;base64,AAAA");
    // Skip the backoff sleep so the test doesn't hang on fake timers.
    await vi.runAllTimersAsync();
    const url = await promise;

    expect(url).toBe(`${IMAGE_BASE_URL}recovered`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on HTTP 5xx and reports the retry to the caller", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(http(503))
      .mockResolvedValueOnce(jsonOk("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();
    const { uploadImage } = await import("../upload-image");

    const promise = uploadImage("data:image/jpeg;base64,AAAA", { onRetry });
    await vi.runAllTimersAsync();
    const url = await promise;

    expect(url).toBe(`${IMAGE_BASE_URL}ok`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it("does NOT retry on HTTP 4xx (e.g. 413 payload too large)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(http(413));
    vi.stubGlobal("fetch", fetchMock);
    const { uploadImage, ImageUploadError } = await import("../upload-image");

    await expect(uploadImage("data:image/jpeg;base64,AAAA"))
      .rejects.toBeInstanceOf(ImageUploadError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after 3 attempts on persistent transport failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const { uploadImage, ImageUploadError } = await import("../upload-image");

    // Subscribe to the rejection *before* draining timers so Node doesn't
    // log it as an unhandled rejection between the two awaits.
    const assertion = expect(uploadImage("data:image/jpeg;base64,AAAA"))
      .rejects.toBeInstanceOf(ImageUploadError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on malformed JSON (server contract violation)", async () => {
    // SyntaxError thrown from res.json() would silently slip through the
    // catch-all `instanceof Error` branch and get retried 3× — defend
    // against that regression.
    const broken = new Response("not-json-at-all", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(broken);
    vi.stubGlobal("fetch", fetchMock);
    const { uploadImage, ImageUploadError } = await import("../upload-image");

    await expect(uploadImage("data:image/jpeg;base64,AAAA"))
      .rejects.toBeInstanceOf(ImageUploadError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the server responds 200 but without an ident (contract violation, not transient)", async () => {
    const broken = new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(broken);
    vi.stubGlobal("fetch", fetchMock);
    const { uploadImage, ImageUploadError } = await import("../upload-image");

    await expect(uploadImage("data:image/jpeg;base64,AAAA"))
      .rejects.toBeInstanceOf(ImageUploadError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("strips the data: URL prefix before sending", async () => {
    let capturedBody = "";
    const fetchMock = vi.fn().mockImplementationOnce((_url, init) => {
      capturedBody = (init as RequestInit).body as string;
      return Promise.resolve(jsonOk());
    });
    vi.stubGlobal("fetch", fetchMock);
    const { uploadImage } = await import("../upload-image");

    await uploadImage("data:image/jpeg;base64,SGVsbG8=");

    expect(capturedBody).toContain("file=SGVsbG8%3D");
    expect(capturedBody).not.toContain("data%3Aimage");
  });
});
