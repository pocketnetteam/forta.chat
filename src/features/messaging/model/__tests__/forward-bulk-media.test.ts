/**
 * Bulk forward — selecting multiple media + text messages and forwarding
 * them must produce per-type events on the target side: m.image for images,
 * m.file for documents, m.text for text. Pre-fix everything collapsed into
 * text bubbles (see forward-media.test.ts for the root cause).
 *
 * Session 52 — closes the bulk path on the same bug.
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

describe("bulk forwardMessages — media + text mixed (Session 52)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.createLocalSpy.mockReset();
    mocks.enqueueSpy.mockReset();
    mocks.attachmentsAddSpy.mockReset();
    mocks.getDecryptedBlobSpy.mockReset();
    mocks.createLocalSpy.mockResolvedValue({ clientId: "client-xyz", localId: 42 });
    mocks.enqueueSpy.mockResolvedValue(1);
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

  it("forwards 2 images + 1 text as 3 events with msgtypes m.image, m.image, m.text", async () => {
    mocks.fakeStoreMessages["!source:server"] = [
      {
        id: "m1",
        roomId: "!source:server",
        senderId: "alice",
        content: "img1",
        timestamp: 100,
        type: MessageType.image,
        fileInfo: { name: "1.jpg", type: "image/jpeg", size: 1, url: "mxc://1" },
      },
      {
        id: "m2",
        roomId: "!source:server",
        senderId: "alice",
        content: "img2",
        timestamp: 110,
        type: MessageType.image,
        fileInfo: { name: "2.jpg", type: "image/jpeg", size: 1, url: "mxc://2" },
      },
      {
        id: "m3",
        roomId: "!source:server",
        senderId: "alice",
        content: "hello world",
        timestamp: 120,
        type: MessageType.text,
      },
    ];

    const { forwardMessages } = useMessages();
    const result = await forwardMessages(
      ["m1", "m2", "m3"],
      "!target:server",
      { withSenderInfo: true },
    );

    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);

    const ops = mocks.enqueueSpy.mock.calls.map((c) => c[0]);
    // Two send_file (images) + one send_message (text), order may vary
    expect(ops.filter((o) => o === "send_file")).toHaveLength(2);
    expect(ops.filter((o) => o === "send_message")).toHaveLength(1);

    // All enqueue invocations carry forwardedFrom attribution
    for (const call of mocks.enqueueSpy.mock.calls) {
      const payload = call[2] as { forwardedFrom?: unknown };
      expect(payload.forwardedFrom).toEqual({ senderId: "alice", senderName: "user-alice" });
    }
  });

  it("forwards a single pdf as one m.file event", async () => {
    mocks.getDecryptedBlobSpy.mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }));
    mocks.fakeStoreMessages["!source:server"] = [
      {
        id: "pdf1",
        roomId: "!source:server",
        senderId: "bob",
        content: "doc.pdf",
        timestamp: 200,
        type: MessageType.file,
        fileInfo: { name: "doc.pdf", type: "application/pdf", size: 3, url: "mxc://pdf" },
      },
    ];

    const { forwardMessages } = useMessages();
    const result = await forwardMessages(["pdf1"], "!target:server", { withSenderInfo: true });

    expect(result.succeeded).toBe(1);
    const [op, , payload] = mocks.enqueueSpy.mock.calls[0];
    expect(op).toBe("send_file");
    expect(payload).toMatchObject({ msgtype: "m.file" });
  });
});
