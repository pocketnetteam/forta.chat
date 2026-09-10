import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { effectScope } from "vue";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression: media went blank because the shared blob-URL cache was cleared
 * by *any* consumer unmounting.
 *
 * `useFileDownload()` registered an unconditional `revokeAllFileUrls()` on
 * scope dispose, but the cache it clears is module-wide. One message bubble,
 * gallery tile or info panel going away revoked the blob URLs every other live
 * consumer was still displaying — and since each instance keeps its own
 * `states` map, the dead URL still read as truthy there, so nothing
 * re-downloaded. The user saw a black MediaViewer on the second open.
 *
 * The cache is now freed when the LAST consumer leaves, plus explicitly on
 * chat switch (`revokeFileUrlsOutsideRoom`) so long sessions don't pin the
 * decrypted bytes of every chat ever opened.
 */

vi.mock("@/shared/lib/platform", () => ({
  isNative: false,
  isElectron: false,
  isAndroid: false,
  isIOS: false,
  getElectronAPI: () => undefined,
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(() => ({ pcrypto: null })),
}));

vi.mock("@/shared/lib/matrix/functions", () => ({
  hexEncode: vi.fn((s: string) => s),
}));

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    mxcToHttp: (mxc: string) =>
      mxc.startsWith("mxc://") ? `https://homeserver.example/${mxc.slice(6)}` : null,
  })),
}));

vi.mock("@/features/bug-report", () => ({
  useBugReport: vi.fn(() => ({ open: vi.fn() })),
}));

vi.mock("@/shared/lib/i18n", () => ({ tRaw: (k: string) => k }));

vi.mock("@/shared/lib/use-toast", () => ({
  useToast: () => ({
    toast: vi.fn(),
    close: vi.fn(),
    message: { value: "" },
    type: { value: "info" },
    show: { value: false },
  }),
}));

vi.mock("@capacitor/core", () => ({ registerPlugin: vi.fn(() => ({ save: vi.fn() })) }));
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { writeFile: vi.fn() },
  Directory: { Cache: "CACHE" },
}));
vi.mock("@capacitor-community/file-opener", () => ({ FileOpener: { open: vi.fn() } }));
vi.mock("@capacitor/share", () => ({ Share: { share: vi.fn() } }));

global.fetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" })),
  }),
) as unknown as Mock;

const { useFileDownload, revokeAllFileUrls, revokeFileUrlsOutsideRoom } = await import(
  "../use-file-download"
);

const makeMessage = (id: string, roomId: string) =>
  ({
    id: `$${id}`,
    _key: id,
    roomId,
    senderId: "@u:server",
    content: `${id}.jpg`,
    timestamp: Date.now(),
    status: "sent",
    type: "image",
    fileInfo: {
      name: `${id}.jpg`,
      type: "image/jpeg",
      size: 3,
      url: `https://example.com/${id}.jpg`,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

/** Run `fn` inside its own effect scope and hand back the scope so the test
 *  controls when that "component" unmounts. */
const openConsumer = async <T>(fn: (api: ReturnType<typeof useFileDownload>) => Promise<T> | T) => {
  const scope = effectScope();
  const api = scope.run(() => useFileDownload())!;
  const result = await fn(api);
  return { scope, api, result };
};

describe("file URL cache lifetime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeAllFileUrls();
  });

  it("keeps cached URLs alive when one of several consumers unmounts", async () => {
    const message = makeMessage("bubble_a", "!room:server");

    const bubble = await openConsumer((api) => api.download(message));
    const viewer = await openConsumer(() => undefined);
    const url = bubble.result as string;
    expect(url).toMatch(/^blob:/);

    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    bubble.scope.stop();

    expect(revokeSpy).not.toHaveBeenCalled();
    // A consumer that never downloaded still resolves the live URL from the
    // shared cache — this is the read MediaViewer performs on open.
    expect(viewer.api.getState("bubble_a").objectUrl).toBe(url);

    viewer.scope.stop();
    expect(revokeSpy).toHaveBeenCalledWith(url);
    revokeSpy.mockRestore();
  });

  it("frees the cache once the last consumer unmounts", async () => {
    const message = makeMessage("last_one", "!room:server");
    const only = await openConsumer((api) => api.download(message));
    const url = only.result as string;

    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    only.scope.stop();

    expect(revokeSpy).toHaveBeenCalledWith(url);

    const fresh = await openConsumer(() => undefined);
    expect(fresh.api.getState("last_one").objectUrl).toBeNull();
    fresh.scope.stop();
    revokeSpy.mockRestore();
  });

  it("re-downloads after the cache was freed instead of handing back a dead URL", async () => {
    const message = makeMessage("revived", "!room:server");

    const first = await openConsumer((api) => api.download(message));
    first.scope.stop();

    const second = await openConsumer((api) => api.download(message));
    expect(second.result).toMatch(/^blob:/);
    expect(second.result).not.toBe(first.result);
    second.scope.stop();
  });

  it("revokeFileUrlsOutsideRoom frees the chat being left and keeps the active one", async () => {
    const inA = makeMessage("in_a", "!a:server");
    const inB = makeMessage("in_b", "!b:server");

    const consumer = await openConsumer(async (api) => {
      const urlA = await api.download(inA);
      const urlB = await api.download(inB);
      return { urlA, urlB };
    });
    const { urlA, urlB } = consumer.result as { urlA: string; urlB: string };

    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    revokeFileUrlsOutsideRoom("!b:server");

    expect(revokeSpy).toHaveBeenCalledWith(urlA);
    expect(revokeSpy).not.toHaveBeenCalledWith(urlB);

    // A newly mounted consumer sees B's URL and nothing for A.
    const fresh = await openConsumer(() => undefined);
    expect(fresh.api.getState("in_b").objectUrl).toBe(urlB);
    expect(fresh.api.getState("in_a").objectUrl).toBeNull();

    fresh.scope.stop();
    consumer.scope.stop();
    revokeSpy.mockRestore();
  });

  it("clears the revoked URL from every live consumer's state (no dead-URL reads)", async () => {
    const inA = makeMessage("stale_a", "!a:server");

    // Two long-lived consumers that never unmount — ChatWindow's voice
    // auto-advance and MessageList's save both read
    // `getState(key).objectUrl ?? download(...)`, so a dead-but-truthy URL
    // there means silent playback failure / a save that writes nothing.
    const writer = await openConsumer((api) => api.download(inA));
    const reader = await openConsumer((api) => {
      // Materialise the state so it holds the URL, like a real read would.
      expect(api.getState("stale_a").objectUrl).toBe(writer.result);
      return undefined;
    });

    revokeFileUrlsOutsideRoom("!b:server");

    expect(reader.api.getState("stale_a").objectUrl).toBeNull();
    expect(writer.api.getState("stale_a").objectUrl).toBeNull();

    // …so the next read re-downloads instead of replaying the dead URL.
    const revived = await reader.api.download(inA);
    expect(revived).toMatch(/^blob:/);
    expect(revived).not.toBe(writer.result);

    reader.scope.stop();
    writer.scope.stop();
  });

  it("revokeAllFileUrls clears live consumers' states too", async () => {
    const message = makeMessage("all_clear", "!a:server");
    const writer = await openConsumer((api) => api.download(message));
    const reader = await openConsumer((api) => {
      api.getState("all_clear");
      return undefined;
    });
    expect(reader.api.getState("all_clear").objectUrl).toBe(writer.result);

    revokeAllFileUrls();

    expect(reader.api.getState("all_clear").objectUrl).toBeNull();
    reader.scope.stop();
    writer.scope.stop();
  });

  it("revokeFileUrlsOutsideRoom(null) frees everything", async () => {
    const consumer = await openConsumer(async (api) => ({
      urlA: await api.download(makeMessage("null_a", "!a:server")),
      urlB: await api.download(makeMessage("null_b", "!b:server")),
    }));
    const { urlA, urlB } = consumer.result as { urlA: string; urlB: string };

    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    revokeFileUrlsOutsideRoom(null);

    expect(revokeSpy).toHaveBeenCalledWith(urlA);
    expect(revokeSpy).toHaveBeenCalledWith(urlB);

    consumer.scope.stop();
    revokeSpy.mockRestore();
  });
});

describe("chat switch wiring", () => {
  // Mounting ChatWindow pulls in the whole chat surface (Matrix client, calls,
  // wallet, live queries), so the one-line wiring is asserted at source level.
  const source = readFileSync(
    resolve(__dirname, "../../../../widgets/chat-window/ChatWindow.vue"),
    "utf-8",
  );

  it("ChatWindow frees the previous chat's media when activeRoomId changes", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*revokeFileUrlsOutsideRoom[^}]*\}\s*from\s*"@\/features\/messaging\/model\/use-file-download"/,
    );
    expect(source).toMatch(
      /watch\(\(\) => chatStore\.activeRoomId,[\s\S]{0,200}?revokeFileUrlsOutsideRoom\(/,
    );
  });
});
