/**
 * Forward media regression — internal forward (ForwardPicker) for media
 * messages must re-upload and arrive as `m.image` / `m.file` / `m.audio` events
 * with the actual attachment, not a text body «Image» without attachment.
 *
 * Root cause (pre-fix): `sendForward(content)` accepted only text and hardcoded
 * `type: MessageType.text`, dropping all media fields on the API boundary.
 * Fix: extend `sendForward(content, meta, source?)` with source-metadata
 * (type, fileInfo, sourceMessageId) and dispatch through the existing
 * `sendImage`/`sendFile`/`sendAudio` pipeline.
 *
 * Closes #311, #702.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { MessageType } from "@/entities/chat";

// ── Spies captured across the test module (must be hoisted for vi.mock) ──
const mocks = vi.hoisted(() => ({
  createLocalSpy: vi.fn(),
  enqueueSpy: vi.fn(),
  attachmentsAddSpy: vi.fn(),
  getDecryptedBlobSpy: vi.fn(),
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
      messages: {},
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

vi.mock("@/shared/lib/i18n", () => ({
  tRaw: (k: string) => k,
}));

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

// ── Import the SUT after mocks are set up ──
import { useMessages } from "../use-messages";

describe("forward media — internal forward re-uploads media (Session 52)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.createLocalSpy.mockReset();
    mocks.enqueueSpy.mockReset();
    mocks.attachmentsAddSpy.mockReset();
    mocks.getDecryptedBlobSpy.mockReset();
    mocks.createLocalSpy.mockResolvedValue({ clientId: "client-xyz", localId: 42 });
    mocks.enqueueSpy.mockResolvedValue(1);
    mocks.attachmentsAddSpy.mockResolvedValue(7);

    // happy-dom's Image doesn't fire load/error for blob: URLs, so
    // getImageDimensions hangs forever. Stub it with an Image-shaped mock
    // that fires onload synchronously the moment .src is assigned.
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
    // @ts-expect-error — override global Image for the test
    globalThis.Image = StubImage;

    // URL.createObjectURL / revokeObjectURL no-op for the same reason.
    if (typeof URL.createObjectURL !== "function") {
      URL.createObjectURL = vi.fn(() => "blob:stub");
    }
    if (typeof URL.revokeObjectURL !== "function") {
      URL.revokeObjectURL = vi.fn();
    }
  });

  it("forwarding an image dispatches send_file enqueue with msgtype m.image (not send_message text)", async () => {
    const blob = new Blob(["fake-jpeg"], { type: "image/jpeg" });
    mocks.getDecryptedBlobSpy.mockResolvedValue(blob);

    const { sendForward } = useMessages();
    const ok = await sendForward(
      "",
      { senderId: "alice", senderName: "Alice" },
      {
        type: MessageType.image,
        fileInfo: {
          name: "photo.jpg",
          type: "image/jpeg",
          size: 9,
          url: "mxc://orig/photo",
        },
        sourceMessageId: "$src:server",
        roomId: "!source:server",
      },
    );

    expect(ok).toBe(true);
    expect(mocks.getDecryptedBlobSpy).toHaveBeenCalled();
    expect(mocks.enqueueSpy).toHaveBeenCalled();
    const [op, , payload] = mocks.enqueueSpy.mock.calls[0];
    expect(op).toBe("send_file");
    expect(payload).toMatchObject({ msgtype: "m.image" });
  });

  it("forwarding a pdf dispatches send_file enqueue with msgtype m.file", async () => {
    const blob = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    mocks.getDecryptedBlobSpy.mockResolvedValue(blob);

    const { sendForward } = useMessages();
    const ok = await sendForward(
      "",
      { senderId: "bob", senderName: "Bob" },
      {
        type: MessageType.file,
        fileInfo: {
          name: "report.pdf",
          type: "application/pdf",
          size: 8,
          url: "mxc://orig/pdf",
        },
        sourceMessageId: "$pdf:server",
        roomId: "!source:server",
      },
    );

    expect(ok).toBe(true);
    const [op, , payload] = mocks.enqueueSpy.mock.calls[0];
    expect(op).toBe("send_file");
    expect(payload).toMatchObject({ msgtype: "m.file" });
  });

  it("forwarded media propagates forwardedFrom attribution into createLocal", async () => {
    const blob = new Blob(["x"], { type: "image/jpeg" });
    mocks.getDecryptedBlobSpy.mockResolvedValue(blob);

    const { sendForward } = useMessages();
    await sendForward(
      "",
      { senderId: "alice", senderName: "Alice" },
      {
        type: MessageType.image,
        fileInfo: { name: "p.jpg", type: "image/jpeg", size: 1, url: "mxc://o" },
        sourceMessageId: "$src",
        roomId: "!src",
      },
    );

    expect(mocks.createLocalSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.image,
        forwardedFrom: { senderId: "alice", senderName: "Alice" },
      }),
    );
  });

  it("forwarding plain text still goes through the legacy send_message path (no regression)", async () => {
    const { sendForward } = useMessages();
    const ok = await sendForward("hello world", { senderId: "alice", senderName: "Alice" });
    expect(ok).toBe(true);
    const [op, , payload] = mocks.enqueueSpy.mock.calls[0];
    expect(op).toBe("send_message");
    expect(payload).toMatchObject({ content: "hello world" });
    expect(mocks.getDecryptedBlobSpy).not.toHaveBeenCalled();
  });

  it("returns false when decrypted blob is unavailable (caller surfaces error)", async () => {
    mocks.getDecryptedBlobSpy.mockResolvedValue(null);

    const { sendForward } = useMessages();
    const ok = await sendForward(
      "",
      undefined,
      {
        type: MessageType.image,
        fileInfo: { name: "p.jpg", type: "image/jpeg", size: 1, url: "mxc://o" },
        sourceMessageId: "$src",
        roomId: "!src",
      },
    );

    expect(ok).toBe(false);
    expect(mocks.enqueueSpy).not.toHaveBeenCalled();
  });
});
