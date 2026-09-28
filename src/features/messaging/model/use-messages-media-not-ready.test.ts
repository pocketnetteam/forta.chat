import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "@/entities/chat";

/**
 * Audit S2-02 (forta-bugs#1387, #1348, #1309, #1367). Text sends were taught to
 * queue while the Matrix client is not ready (WEE-85), but photo, video, voice
 * and file sends still returned false before touching Dexie: the attachment
 * vanished, the picker was cleared, and the only trace was a banner without a
 * retry button. They must queue like text does — SyncEngine holds the op until
 * Matrix is ready (and fails it visibly past its ceiling).
 */

vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(() => ({ address: "PMyAddress123456789012345678901234", pcrypto: null })),
}));
vi.mock("@/shared/lib/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/shared/lib/connectivity", () => ({ useConnectivity: vi.fn(() => ({ isOnline: { value: true } })) }));
vi.mock("heic2any", () => ({ default: vi.fn(async () => new Blob(["jpeg"], { type: "image/jpeg" })) }));

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    isReady: () => false,
    getUserId: () => "@mockuser:server",
    getRoom: vi.fn(),
    setTyping: vi.fn(),
  })),
  resetMatrixClientService: vi.fn(),
  MatrixClientService: vi.fn(),
}));

const enqueue = vi.fn(async () => undefined);
const createLocal = vi.fn(async () => ({ localId: 11, clientId: "client-1" }));
vi.mock("@/shared/lib/local-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/local-db")>();
  return {
    ...actual,
    isChatDbReady: () => true,
    getChatDb: () => ({
      messages: { createLocal, updateStatus: vi.fn(), update: vi.fn() },
      db: { attachments: { add: vi.fn(async () => 7) } },
      syncEngine: { enqueue },
    }),
  };
});

import { useMessages } from "./use-messages";

// happy-dom never loads a blob URL into <img>, so sendImage's dimension probe
// would wait forever; a real WebView always fires load or error.
class LoadedImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 4;
  naturalHeight = 3;
  set src(_url: string) {
    queueMicrotask(() => this.onload?.());
  }
}
vi.stubGlobal("Image", LoadedImage);

function file(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe("media sends while the Matrix client is not ready (audit S2-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createTestingPinia({ stubActions: false }));
    useChatStore().activeRoomId = "!room:server";
  });

  it("queues a file instead of dropping it", async () => {
    const ok = await useMessages().sendFile(file("report.pdf", "application/pdf"));
    expect(ok).toBe(true);
    expect(createLocal).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("send_file", "!room:server", expect.any(Object), "client-1");
  });

  it("queues a photo", async () => {
    const ok = await useMessages().sendImage(file("photo.jpg", "image/jpeg"));
    expect(ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("queues a voice message", async () => {
    const ok = await useMessages().sendAudio(file("voice.webm", "audio/webm"), { duration: 3 });
    expect(ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("queues a video circle", async () => {
    const ok = await useMessages().sendVideoCircle(file("circle.mp4", "video/mp4"), { duration: 3 });
    expect(ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
