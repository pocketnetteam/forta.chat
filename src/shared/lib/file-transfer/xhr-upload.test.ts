import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadBlobWithProgress } from "./xhr-upload";

/** Minimal XMLHttpRequest double: the test drives progress and completion. */
class FakeXhr {
  static last: FakeXhr;
  headers: Record<string, string> = {};
  method = "";
  url = "";
  body: unknown;
  status = 0;
  responseText = "";
  upload: { onprogress: ((ev: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  finish(status: number, responseText: string) {
    this.status = status;
    this.responseText = responseText;
    this.onload?.();
  }
}

describe("uploadBlobWithProgress", () => {
  beforeEach(() => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const blob = new Blob(["abcdef"], { type: "image/png" });
  const base = {
    url: "https://matrix.example/_matrix/media/v3/upload",
    authorization: "Bearer t",
    blob,
    contentType: "image/png",
  };

  it("posts the blob with auth and reports progress, resolving with the body", async () => {
    const onProgress = vi.fn();
    const done = uploadBlobWithProgress({ ...base, onProgress });
    const xhr = FakeXhr.last;

    expect(xhr.method).toBe("POST");
    expect(xhr.headers).toEqual({ Authorization: "Bearer t", "Content-Type": "image/png" });
    expect(xhr.body).toBe(blob);

    xhr.upload.onprogress?.({ loaded: 3, total: 6, lengthComputable: true });
    expect(onProgress).toHaveBeenLastCalledWith({ loaded: 3, total: 6 });

    xhr.finish(200, '{"content_uri":"mxc://s/abc"}');
    await expect(done).resolves.toBe('{"content_uri":"mxc://s/abc"}');
  });

  it("names the HTTP status so a 413 counts as fatal upstream", async () => {
    const done = uploadBlobWithProgress({ ...base, onProgress: vi.fn() });
    FakeXhr.last.finish(413, '{"errcode":"M_TOO_LARGE","error":"File too large"}');
    await expect(done).rejects.toThrow(/status 413 \(M_TOO_LARGE: File too large\)/);
  });

  it("aborts on the signal with an AbortError", async () => {
    const controller = new AbortController();
    const done = uploadBlobWithProgress({ ...base, onProgress: vi.fn(), signal: controller.signal });
    controller.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.last.aborted).toBe(true);
  });

  it("rejects on a network error", async () => {
    const done = uploadBlobWithProgress({ ...base, onProgress: vi.fn() });
    FakeXhr.last.onerror?.();
    await expect(done).rejects.toThrow("network error");
  });
});
