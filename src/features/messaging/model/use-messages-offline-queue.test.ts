// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, reactive } from "vue";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore, MessageStatus } from "@/entities/chat";

/**
 * Audit S2-04. The legacy send path (Dexie not ready) queued a message while
 * offline and marked it "sent" at once, though it sat only on the device. The
 * drain took a message off the queue before checking that Matrix was ready,
 * so a drain run on `online` while Matrix still reconnected dropped it for
 * good, and nothing drained the queue when Matrix came back later.
 */

const auth = reactive({ address: "PMyAddress123456789012345678901234", pcrypto: null, matrixReady: true });
vi.mock("@/entities/auth", () => ({ useAuthStore: vi.fn(() => auth) }));
vi.mock("@/shared/lib/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const online = { value: false };
vi.mock("@/shared/lib/connectivity", () => ({ useConnectivity: vi.fn(() => ({ isOnline: online })) }));

const matrix = { ready: true };
const sendText = vi.fn(async () => "$server-event");
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    isReady: () => matrix.ready,
    getUserId: () => "@mockuser:server",
    getRoom: vi.fn(() => null),
    setTyping: vi.fn(),
    sendText,
    sendEncryptedText: vi.fn(),
  })),
  resetMatrixClientService: vi.fn(),
  MatrixClientService: vi.fn(),
}));
vi.mock("@/shared/lib/local-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/local-db")>();
  return { ...actual, isChatDbReady: () => false };
});

import { useMessages } from "./use-messages";
import { getQueue, clearQueue } from "@/shared/lib/offline-queue";

const ROOM = "!room:server";

function statusOfLast(): MessageStatus | undefined {
  const msgs = useChatStore().messages[ROOM] ?? [];
  return msgs[msgs.length - 1]?.status;
}

describe("legacy offline queue (audit S2-04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearQueue();
    setActivePinia(createTestingPinia({ stubActions: false }));
    useChatStore().activeRoomId = ROOM;
    online.value = false;
    matrix.ready = true;
    auth.matrixReady = true;
  });

  it("keeps a message queued offline as sending, not sent", async () => {
    const scope = effectScope();
    const messaging = scope.run(() => useMessages())!;
    await messaging.sendMessage("hello while offline");

    expect(getQueue()).toHaveLength(1);
    expect(statusOfLast()).toBe(MessageStatus.sending);
    scope.stop();
  });

  it("leaves the message queued when Matrix is not ready at drain time, and sends it once Matrix is back", async () => {
    const scope = effectScope();
    const messaging = scope.run(() => useMessages())!;
    await messaging.sendMessage("hello while offline");

    // Back online while Matrix still reconnects: nothing may be lost.
    online.value = true;
    matrix.ready = false;
    auth.matrixReady = false;
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(getQueue()).toHaveLength(1));
    expect(sendText).not.toHaveBeenCalled();

    // Matrix ready again: the queue drains without another `online` event.
    matrix.ready = true;
    auth.matrixReady = true;
    await nextTick();
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith(ROOM, "hello while offline"));
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0));
    expect(statusOfLast()).toBe(MessageStatus.sent);
    scope.stop();
  });
});
