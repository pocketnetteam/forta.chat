/**
 * WEE-98 regression — bulk forward must preserve the source chronological
 * order. forwardMessages sorts by source timestamp, but the pre-fix code
 * then sent everything through Promise.allSettled(collected.map(...)) —
 * a parallel race where the SyncEngine enqueue order (FIFO = send order)
 * depended on which send resolved its awaits first, so recipients saw the
 * messages shuffled. The fix sends strictly sequentially.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { MessageType } from "@/entities/chat";

const mocks = vi.hoisted(() => ({
  createLocalSpy: vi.fn(),
  enqueueSpy: vi.fn(),
  attachmentsAddSpy: vi.fn(),
  getDecryptedBlobSpy: vi.fn(),
  fakeStoreMessages: {} as Record<string, unknown[]>,
  callLog: [] as string[],
}));

vi.mock("@/shared/lib/local-db", () => ({
  isChatDbReady: vi.fn(() => true),
  getChatDb: vi.fn(() => ({
    messages: {
      createLocal: mocks.createLocalSpy,
      markFailed: vi.fn(),
      getByClientId: vi.fn(),
      updateUploadProgress: vi.fn(),
      confirmMediaSent: vi.fn(),
    },
    syncEngine: { enqueue: mocks.enqueueSpy },
    db: {
      attachments: { add: mocks.attachmentsAddSpy },
      messages: { where: vi.fn(() => ({ equals: vi.fn(() => ({ modify: vi.fn() })) })) },
    },
    eventWriter: {},
  })),
}));

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    isReady: () => true,
    uploadContent: vi.fn(),
    sendEncryptedText: vi.fn(),
    setTyping: vi.fn(),
  })),
}));

vi.mock("@/entities/matrix/model/matrix-crypto", () => ({
  ENCRYPTION_REQUIRED_NO_KEYS: "ENCRYPTION_REQUIRED_NO_KEYS",
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    address: "0xme",
    pcrypto: { rooms: {} },
  }),
}));

vi.mock("@/entities/chat", async () => {
  const actual = await vi.importActual<typeof import("@/entities/chat")>("@/entities/chat");
  return {
    ...actual,
    useChatStore: () => ({
      activeRoomId: "!target:server",
      get messages() {
        return mocks.fakeStoreMessages;
      },
      addMessage: vi.fn(),
      updateMessageContent: vi.fn(),
      updateMessageStatus: vi.fn(),
      updateMessageIdAndStatus: vi.fn(),
      removeMessage: vi.fn(),
      getDisplayName: vi.fn((id: string) => `user-${id}`),
      loadRoomMessages: vi.fn(),
    }),
  };
});

vi.mock("../use-file-download", () => ({
  getDecryptedBlobForMessage: mocks.getDecryptedBlobSpy,
  invalidateDownloadCache: vi.fn(),
}));

vi.mock("@/features/bug-report", () => ({
  useBugReport: () => ({ open: vi.fn() }),
}));

vi.mock("@/shared/lib/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/shared/lib/i18n", () => ({ tRaw: (k: string) => k }));

vi.mock("@/shared/lib/connectivity", () => ({
  useConnectivity: () => ({ isOnline: { value: true } }),
}));

vi.mock("@/shared/lib/offline-queue", () => ({
  enqueue: vi.fn(),
  dequeue: vi.fn(),
  getQueue: vi.fn(() => []),
}));

vi.mock("./use-link-preview", () => ({
  detectUrl: vi.fn(() => null),
  fetchPreview: vi.fn(),
}));

import { useMessages } from "../use-messages";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const textMessage = (id: string, content: string, timestamp: number) => ({
  id,
  roomId: "!source:server",
  senderId: "alice",
  content,
  timestamp,
  type: MessageType.text,
});

describe("forwardMessages — order preservation (WEE-98)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.createLocalSpy.mockReset();
    mocks.enqueueSpy.mockReset();
    mocks.attachmentsAddSpy.mockReset();
    mocks.getDecryptedBlobSpy.mockReset();
    mocks.callLog.length = 0;
    for (const k of Object.keys(mocks.fakeStoreMessages)) delete mocks.fakeStoreMessages[k];

    mocks.createLocalSpy.mockImplementation(async (args: { content: string }) => {
      mocks.callLog.push(`createLocal:${args.content}`);
      return { clientId: `client-${args.content}`, localId: 1 };
    });
    mocks.enqueueSpy.mockImplementation(async (...call: unknown[]) => {
      const payload = call[2] as { content?: string; msgtype?: string };
      mocks.callLog.push(`enqueue:${payload.content ?? payload.msgtype}`);
      return 1;
    });
    mocks.attachmentsAddSpy.mockResolvedValue(7);
    mocks.getDecryptedBlobSpy.mockResolvedValue(new Blob(["x"], { type: "image/jpeg" }));

    class StubImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 320;
      naturalHeight = 240;
      private _src = "";
      get src(): string { return this._src; }
      set src(v: string) {
        this._src = v;
        queueMicrotask(() => this.onload?.());
      }
    }
    // @ts-expect-error — override global Image
    globalThis.Image = StubImage;
  });

  it("sends strictly sequentially: each message fully enqueued before the next starts", async () => {
    // Pre-fix, Promise.allSettled(map) kicked off every send at once, so the
    // call log started with three createLocal entries back-to-back. The
    // sequential loop must interleave createLocal/enqueue pairs instead.
    mocks.fakeStoreMessages["!source:server"] = [
      textMessage("m1", "first", 100),
      textMessage("m2", "second", 200),
      textMessage("m3", "third", 300),
    ];

    const { forwardMessages } = useMessages();
    const result = await forwardMessages(["m1", "m2", "m3"], "!target:server");

    expect(result).toEqual({ succeeded: 3, failed: 0 });
    expect(mocks.callLog).toEqual([
      "createLocal:first",
      "enqueue:first",
      "createLocal:second",
      "enqueue:second",
      "createLocal:third",
      "enqueue:third",
    ]);
  });

  it("preserves source-timestamp order even when the earliest message is the slowest", async () => {
    // Give the chronologically-first message the slowest createLocal. A
    // parallel implementation would enqueue the fast ones first and shuffle
    // the recipient's order; sequential sending keeps t1 < t2 < t3.
    const slowness: Record<string, number> = { first: 30, second: 15, third: 0 };
    mocks.createLocalSpy.mockImplementation(async (args: { content: string }) => {
      await delay(slowness[args.content] ?? 0);
      mocks.callLog.push(`createLocal:${args.content}`);
      return { clientId: `client-${args.content}`, localId: 1 };
    });

    // Selection order is also scrambled — forwardMessages must sort by timestamp.
    mocks.fakeStoreMessages["!source:server"] = [
      textMessage("m3", "third", 300),
      textMessage("m1", "first", 100),
      textMessage("m2", "second", 200),
    ];

    const { forwardMessages } = useMessages();
    const result = await forwardMessages(["m3", "m2", "m1"], "!target:server");

    expect(result).toEqual({ succeeded: 3, failed: 0 });
    const enqueued = mocks.enqueueSpy.mock.calls.map(
      (c) => (c[2] as { content: string }).content,
    );
    expect(enqueued).toEqual(["first", "second", "third"]);
  });

  it("mixed media + text keeps timestamp order across both branches", async () => {
    mocks.fakeStoreMessages["!source:server"] = [
      textMessage("t1", "hello", 150),
      {
        id: "img1",
        roomId: "!source:server",
        senderId: "alice",
        content: "img1",
        timestamp: 100,
        type: MessageType.image,
        fileInfo: { name: "1.jpg", type: "image/jpeg", size: 1, url: "mxc://1" },
      },
      {
        id: "img2",
        roomId: "!source:server",
        senderId: "alice",
        content: "img2",
        timestamp: 200,
        type: MessageType.image,
        fileInfo: { name: "2.jpg", type: "image/jpeg", size: 1, url: "mxc://2" },
      },
    ];

    const { forwardMessages } = useMessages();
    const result = await forwardMessages(["t1", "img1", "img2"], "!target:server");

    expect(result).toEqual({ succeeded: 3, failed: 0 });
    // timestamps: img1(100) < t1(150) < img2(200)
    const ops = mocks.enqueueSpy.mock.calls.map((c) => c[0]);
    expect(ops).toEqual(["send_file", "send_message", "send_file"]);
  });

  it("continues after a failed message and keeps the rest in order", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Fail "second" at the enqueue level; it then takes the legacy fallback
    // (mocked to succeed). What this test pins down is that the loop keeps
    // going and the surrounding messages stay in order.
    mocks.enqueueSpy.mockImplementation(async (...call: unknown[]) => {
      const payload = call[2] as { content?: string };
      if (payload.content === "second") throw new Error("enqueue down");
      mocks.callLog.push(`enqueue:${payload.content}`);
      return 1;
    });

    mocks.fakeStoreMessages["!source:server"] = [
      textMessage("m1", "first", 100),
      textMessage("m2", "second", 200),
      textMessage("m3", "third", 300),
    ];

    const { forwardMessages } = useMessages();
    const result = await forwardMessages(["m1", "m2", "m3"], "!target:server");

    // "second" still succeeds via the legacy direct-send fallback (mocked OK,
    // no encryption gate in this setup) — the loop must not abort on its error.
    expect(result).toEqual({ succeeded: 3, failed: 0 });
    expect(mocks.callLog).toEqual([
      "createLocal:first",
      "enqueue:first",
      "createLocal:second",
      "createLocal:third",
      "enqueue:third",
    ]);
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});
