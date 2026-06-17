/**
 * Video circle (video note) send — crash-safe regression (WEE-62 / forta-bugs#852, #718).
 *
 * Root cause (pre-fix): `sendVideoCircle` ran encrypt→upload→send inline in a
 * fire-and-forget IIFE WITHOUT a `PendingOperation` in the Dexie queue. If the
 * WebView was killed mid-upload (a 4-minute window on slow links) the send was
 * lost with no auto-retry — unlike `sendImage`/`sendFile`/`sendAudio`, which all
 * enqueue `send_file` through the crash-safe `SyncEngine`. That asymmetry is the
 * "photo ok, video hangs" report.
 *
 * Fix: route `sendVideoCircle` through `SyncEngine.enqueue("send_file", …)` with
 * `msgtype: "m.video"`, persisting the blob as an attachment so `syncSendFile`
 * can resume after a crash. The video-note markers (`videoNote` /
 * MSC3245 `video_note`) must land inside `content.info` (`eventInfo`) so the
 * receiver's `isVideoNoteInfo` heuristic still classifies it as a circle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { MessageType } from "@/entities/chat";
import { MSC3245_VIDEO_NOTE_KEY } from "@/entities/chat/lib/chat-helpers";

// ── Spies hoisted for vi.mock ──
const mocks = vi.hoisted(() => ({
  createLocalSpy: vi.fn(),
  enqueueSpy: vi.fn(),
  attachmentsAddSpy: vi.fn(),
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
      activeRoomId: "!room:server",
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
  getDecryptedBlobForMessage: vi.fn(),
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

import { useMessages } from "../use-messages";

function makeVideoFile(): File {
  return new File([new Uint8Array([0, 1, 2, 3])], "circle.mp4", { type: "video/mp4" });
}

describe("sendVideoCircle — crash-safe SyncEngine queue (WEE-62)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.createLocalSpy.mockReset();
    mocks.enqueueSpy.mockReset();
    mocks.attachmentsAddSpy.mockReset();
    mocks.createLocalSpy.mockResolvedValue({ clientId: "client-vid", localId: 99 });
    mocks.enqueueSpy.mockResolvedValue(1);
    mocks.attachmentsAddSpy.mockResolvedValue(7);

    if (typeof URL.createObjectURL !== "function") {
      URL.createObjectURL = vi.fn(() => "blob:stub");
    }
    if (typeof URL.revokeObjectURL !== "function") {
      URL.revokeObjectURL = vi.fn();
    }
  });

  it("enqueues send_file with msgtype m.video (does NOT bypass the queue)", async () => {
    const { sendVideoCircle } = useMessages();
    await sendVideoCircle(makeVideoFile(), { duration: 4.2 });

    expect(mocks.enqueueSpy).toHaveBeenCalledTimes(1);
    const [op, roomId, payload, clientId] = mocks.enqueueSpy.mock.calls[0];
    expect(op).toBe("send_file");
    expect(roomId).toBe("!room:server");
    expect(clientId).toBe("client-vid");
    expect(payload).toMatchObject({ msgtype: "m.video", attachmentId: 7 });
  });

  it("persists the blob as an attachment so syncSendFile can resume after a crash", async () => {
    const file = makeVideoFile();
    const { sendVideoCircle } = useMessages();
    await sendVideoCircle(file, { duration: 1 });

    expect(mocks.attachmentsAddSpy).toHaveBeenCalledTimes(1);
    const attachmentArg = mocks.attachmentsAddSpy.mock.calls[0][0];
    expect(attachmentArg).toMatchObject({
      messageLocalId: 99,
      mimeType: "video/mp4",
      status: "local",
    });
    expect(attachmentArg.localBlob).toBeInstanceOf(Blob);
  });

  it("carries the video-note markers inside eventInfo so the receiver classifies it as a circle", async () => {
    const { sendVideoCircle } = useMessages();
    await sendVideoCircle(makeVideoFile(), { duration: 2 });

    const payload = mocks.enqueueSpy.mock.calls[0][2] as {
      eventInfo?: Record<string, unknown>;
    };
    expect(payload.eventInfo).toBeDefined();
    expect(payload.eventInfo).toMatchObject({
      videoNote: true,
      [MSC3245_VIDEO_NOTE_KEY]: true,
      mimetype: "video/mp4",
      w: 480,
      h: 480,
    });
    // duration is serialised to milliseconds on the wire
    expect(payload.eventInfo!.duration).toBe(2000);
  });

  it("creates the optimistic local message as a videoCircle", async () => {
    const { sendVideoCircle } = useMessages();
    await sendVideoCircle(makeVideoFile());

    expect(mocks.createLocalSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: MessageType.videoCircle }),
    );
  });

  it("propagates forwardedFrom attribution into the enqueued payload", async () => {
    const { sendVideoCircle } = useMessages();
    await sendVideoCircle(makeVideoFile(), {
      forwardedFrom: { senderId: "alice", senderName: "Alice" },
    });

    const payload = mocks.enqueueSpy.mock.calls[0][2] as {
      forwardedFrom?: { senderId: string; senderName?: string };
    };
    expect(payload.forwardedFrom).toEqual({ senderId: "alice", senderName: "Alice" });
  });

  it("returns false and does NOT enqueue when the chat DB is not ready", async () => {
    const localDb = await import("@/shared/lib/local-db");
    vi.mocked(localDb.isChatDbReady).mockReturnValueOnce(false);

    const { sendVideoCircle } = useMessages();
    const ok = await sendVideoCircle(makeVideoFile());

    expect(ok).toBe(false);
    expect(mocks.enqueueSpy).not.toHaveBeenCalled();
    expect(mocks.attachmentsAddSpy).not.toHaveBeenCalled();
  });

  it("returns true on a successful enqueue", async () => {
    const { sendVideoCircle } = useMessages();
    const ok = await sendVideoCircle(makeVideoFile());
    expect(ok).toBe(true);
  });
});
