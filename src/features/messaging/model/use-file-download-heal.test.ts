import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

/**
 * Regression coverage for WEE-40 lazy heal: a row whose fileInfo.url is
 * still `blob:` after a reload (confirmMediaSent never ran, /sync echo
 * won the race) must be self-healed at download-time by refetching the
 * event from Matrix and persisting the recovered fileInfo.
 */

// --- Mocks ---
let mockIsNative = false;
let mockIsElectron = false;
let mockIsAndroid = false;
vi.mock("@/shared/lib/platform", () => ({
  get isNative() { return mockIsNative; },
  get isElectron() { return mockIsElectron; },
  get isAndroid() { return mockIsAndroid; },
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(() => ({ get pcrypto() { return null; } })),
}));

vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { writeFile: vi.fn() },
  Directory: { Cache: "CACHE" },
}));
vi.mock("@capacitor-community/file-opener", () => ({ FileOpener: { open: vi.fn() } }));
vi.mock("@capacitor/share", () => ({ Share: { share: vi.fn() } }));
vi.mock("@capacitor/core", () => ({ registerPlugin: vi.fn(() => ({ save: vi.fn() })) }));

vi.mock("@/shared/lib/matrix/functions", () => ({
  hexEncode: vi.fn((s: string) => s),
}));

vi.mock("@/features/bug-report", () => ({
  useBugReport: vi.fn(() => ({ open: vi.fn() })),
}));
vi.mock("@/shared/lib/i18n", () => ({ tRaw: (k: string) => k }));

const mockToast: Mock = vi.fn();
vi.mock("@/shared/lib/use-toast", () => ({
  useToast: () => ({ toast: mockToast, close: vi.fn(), message: { value: "" }, type: { value: "info" }, show: { value: false } }),
}));

// fetchRoomEvent is the heal pivot — tests override it per case.
const mockFetchRoomEvent: Mock = vi.fn();
const mockMxcToHttp: Mock = vi.fn((mxc: string) =>
  mxc.startsWith("mxc://") ? `https://homeserver/_matrix/media/r0/download/${mxc.slice(6)}` : null,
);
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    fetchRoomEvent: mockFetchRoomEvent,
    mxcToHttp: mockMxcToHttp,
  })),
}));

// updateFileInfo is the persistence pivot — assert it gets called with
// the healed shape.
const mockUpdateFileInfo: Mock = vi.fn(() => Promise.resolve());
let mockChatDbReady = true;
vi.mock("@/shared/lib/local-db", () => ({
  getChatDb: () => ({
    messages: { updateFileInfo: mockUpdateFileInfo },
  }),
  isChatDbReady: () => mockChatDbReady,
}));

vi.mock("@/shared/lib/media-cache", () => ({ getMediaCache: () => null }));

const mockFetchResponse = {
  ok: true,
  blob: () => Promise.resolve(new Blob(["healed"], { type: "image/jpeg" })),
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
};
global.fetch = vi.fn(() => Promise.resolve(mockFetchResponse)) as Mock;

const { tryHealStaleBlobFileInfo } = await import("./use-file-download");

describe("tryHealStaleBlobFileInfo (WEE-40 lazy heal)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatDbReady = true;
  });

  it("recovers mxc:// URL + secrets from a Matrix event and persists to Dexie", async () => {
    mockFetchRoomEvent.mockResolvedValueOnce({
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
        url: "mxc://server/realphoto",
        info: {
          mimetype: "image/jpeg",
          secrets: { block: 1, keys: "deadbeef", v: 1 },
        },
      },
    });

    const local = {
      name: "photo.jpg",
      type: "image/jpeg",
      size: 2048,
      url: "blob:http://localhost:5173/stale",
    };

    const healed = await tryHealStaleBlobFileInfo("$evt", "!room:server", local);

    expect(healed).not.toBeNull();
    expect(healed!.url).toBe("mxc://server/realphoto");
    expect(healed!.secrets).toEqual({ block: 1, keys: "deadbeef", v: 1 });
    // Other fields preserved from local snapshot.
    expect(healed!.name).toBe("photo.jpg");
    expect(healed!.size).toBe(2048);

    // Persisted under the eventId so future renders skip the fetch.
    expect(mockUpdateFileInfo).toHaveBeenCalledWith("$evt", healed);
  });

  it("falls back to top-level content.secrets when content.info.secrets is absent", async () => {
    // Older m.file shape from Bastyon clients puts secrets at the top.
    mockFetchRoomEvent.mockResolvedValueOnce({
      content: {
        msgtype: "m.file",
        body: "doc.pdf",
        url: "mxc://server/docfile",
        secrets: { block: 2, keys: "topsecret", v: 1 },
      },
    });

    const local = {
      name: "doc.pdf",
      type: "application/pdf",
      size: 1024,
      url: "blob:http://localhost:5173/stale",
    };

    const healed = await tryHealStaleBlobFileInfo("$evt2", "!room:server", local);
    expect(healed?.url).toBe("mxc://server/docfile");
    expect(healed?.secrets).toEqual({ block: 2, keys: "topsecret", v: 1 });
  });

  it("falls back to content.pbody.secrets for legacy Bastyon-shape events", async () => {
    // Some older Bastyon clients put secrets under content.pbody alongside
    // the body — downloadAndDecrypt already reads from this path. The heal
    // must too, otherwise decryption silently fails after url heal.
    mockFetchRoomEvent.mockResolvedValueOnce({
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
        url: "mxc://server/legacypbody",
        pbody: {
          secrets: { block: 3, keys: "pbodykey", v: 1 },
        },
      },
    });

    const local = {
      name: "photo.jpg",
      type: "image/jpeg",
      size: 2048,
      url: "blob:http://localhost:5173/stale",
    };

    const healed = await tryHealStaleBlobFileInfo("$evt_pbody", "!room:server", local);
    expect(healed?.url).toBe("mxc://server/legacypbody");
    expect(healed?.secrets).toEqual({ block: 3, keys: "pbodykey", v: 1 });
  });

  it("returns null when the server event has no usable url", async () => {
    mockFetchRoomEvent.mockResolvedValueOnce({
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
        // url missing — sender's send pipeline never finalised either
      },
    });

    const local = {
      name: "photo.jpg",
      type: "image/jpeg",
      size: 2048,
      url: "blob:http://localhost:5173/stale",
    };

    const healed = await tryHealStaleBlobFileInfo("$evt3", "!room:server", local);
    expect(healed).toBeNull();
    // Nothing to persist when heal failed.
    expect(mockUpdateFileInfo).not.toHaveBeenCalled();
  });

  it("returns null when the event content itself carries a blob: url (sender lost it too)", async () => {
    mockFetchRoomEvent.mockResolvedValueOnce({
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
        url: "blob:http://something/else",
      },
    });

    const local = {
      name: "photo.jpg",
      type: "image/jpeg",
      size: 2048,
      url: "blob:http://localhost:5173/stale",
    };

    expect(await tryHealStaleBlobFileInfo("$evt4", "!room:server", local)).toBeNull();
  });

  it("returns null when fetchRoomEvent yields null (event not in timeline / offline)", async () => {
    mockFetchRoomEvent.mockResolvedValueOnce(null);

    const local = {
      name: "photo.jpg",
      type: "image/jpeg",
      size: 2048,
      url: "blob:http://localhost:5173/stale",
    };

    expect(await tryHealStaleBlobFileInfo("$evt5", "!room:server", local)).toBeNull();
  });

  it("still returns healed fileInfo even when Dexie persist throws (heal must not block render)", async () => {
    mockFetchRoomEvent.mockResolvedValueOnce({
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
        url: "mxc://server/recovered",
      },
    });
    mockUpdateFileInfo.mockRejectedValueOnce(new Error("Dexie closed"));

    const local = {
      name: "photo.jpg",
      type: "image/jpeg",
      size: 2048,
      url: "blob:http://localhost:5173/stale",
    };

    const healed = await tryHealStaleBlobFileInfo("$evt6", "!room:server", local);
    expect(healed?.url).toBe("mxc://server/recovered");
  });

  it("skips Dexie persist when chat-db is not initialised (logout race)", async () => {
    mockChatDbReady = false;
    mockFetchRoomEvent.mockResolvedValueOnce({
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
        url: "mxc://server/nodb",
      },
    });

    const local = {
      name: "photo.jpg",
      type: "image/jpeg",
      size: 2048,
      url: "blob:http://localhost:5173/stale",
    };

    const healed = await tryHealStaleBlobFileInfo("$evt7", "!room:server", local);
    expect(healed?.url).toBe("mxc://server/nodb");
    expect(mockUpdateFileInfo).not.toHaveBeenCalled();
  });
});
