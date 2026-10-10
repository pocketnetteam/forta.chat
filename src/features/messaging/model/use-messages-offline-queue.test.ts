// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, reactive, ref } from "vue";
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
const online = ref(false);
vi.mock("@/shared/lib/connectivity", () => ({ useConnectivity: vi.fn(() => ({ isOnline: online })) }));

const matrix = { ready: true };
const sendText = vi.fn<(roomId: string, text: string, txnId?: string) => Promise<string>>(async () => "$server-event");
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
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith(ROOM, "hello while offline", expect.any(String)));
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0));
    expect(statusOfLast()).toBe(MessageStatus.sent);
    scope.stop();
  });

  // Review 2026-10-10: Matrix can turn ready from its cache while the phone is
  // still offline; the drain then failed the message instead of waiting.
  it("does not drain while offline, even when Matrix turns ready", async () => {
    const scope = effectScope();
    const messaging = scope.run(() => useMessages())!;
    await messaging.sendMessage("hello while offline");
    auth.matrixReady = false;
    await nextTick();
    auth.matrixReady = true;
    await nextTick();
    await new Promise((r) => setTimeout(r, 20));

    expect(sendText).not.toHaveBeenCalled();
    expect(getQueue()).toHaveLength(1);
    expect(statusOfLast()).toBe(MessageStatus.sending);
    scope.stop();
  });

  it("keeps the message queued as sending when the network drops during the send, and sends it on the next drain", async () => {
    const scope = effectScope();
    const messaging = scope.run(() => useMessages())!;
    await messaging.sendMessage("hello while offline");
    sendText.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    online.value = true;
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(getQueue()).toHaveLength(1);
    expect(statusOfLast()).toBe(MessageStatus.sending);

    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0));
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(statusOfLast()).toBe(MessageStatus.sent);
    scope.stop();
  });

  it("drops a message the server refuses and marks it failed", async () => {
    const scope = effectScope();
    const messaging = scope.run(() => useMessages())!;
    await messaging.sendMessage("hello while offline");
    sendText.mockRejectedValueOnce(new Error("M_FORBIDDEN: not in room"));

    online.value = true;
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0));
    expect(statusOfLast()).toBe(MessageStatus.failed);
    scope.stop();
  });

  it("sends each queued message once when two drains start together", async () => {
    const scope = effectScope();
    const messaging = scope.run(() => useMessages())!;
    await messaging.sendMessage("first");
    await messaging.sendMessage("second");
    let release: () => void = () => {};
    sendText.mockImplementationOnce(() => new Promise<string>((r) => { release = () => r("$first"); }));

    online.value = true;
    await nextTick();
    window.dispatchEvent(new Event("online"));
    auth.matrixReady = false;
    await nextTick();
    auth.matrixReady = true;
    await nextTick();
    release();
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0));

    expect(sendText.mock.calls.map((c) => c[1])).toEqual(["first", "second"]);
    scope.stop();
  });

  it("sends a queued message once while two components hold useMessages", async () => {
    const scope = effectScope();
    const [input] = scope.run(() => [useMessages(), useMessages()])!;
    await input.sendMessage("hello while offline");

    online.value = true;
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0));
    await new Promise((r) => setTimeout(r, 20));

    expect(sendText).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  // Review 2026-10-10: a send whose response was lost stays queued and goes
  // out again; without the message's id as txnId the server got a duplicate.
  it("sends with the message id as txnId so a repeat is deduped by the server", async () => {
    const scope = effectScope();
    const messaging = scope.run(() => useMessages())!;
    await messaging.sendMessage("hello while offline");
    const queuedId = getQueue()[0].id;

    online.value = true;
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0));
    expect(sendText).toHaveBeenCalledWith(ROOM, "hello while offline", queuedId);
    scope.stop();
  });

  it("runs once more for a trigger that came while a drain was busy", async () => {
    const scope = effectScope();
    const messaging = scope.run(() => useMessages())!;
    await messaging.sendMessage("first");
    let fail: (e: Error) => void = () => {};
    sendText.mockImplementationOnce(() => new Promise<string>((_r, rej) => { fail = rej; }));

    online.value = true;
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    // The network flaps while the first send hangs: this trigger must not be lost.
    window.dispatchEvent(new Event("online"));
    fail(new TypeError("Failed to fetch"));

    await vi.waitFor(() => expect(getQueue()).toHaveLength(0));
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(statusOfLast()).toBe(MessageStatus.sent);
    scope.stop();
  });

  it("keeps a send that hangs queued instead of holding the drain", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const scope = effectScope();
      const messaging = scope.run(() => useMessages())!;
      await messaging.sendMessage("hello while offline");
      sendText.mockImplementationOnce(() => new Promise<string>(() => {}));

      online.value = true;
      await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getQueue()).toHaveLength(1);
      expect(statusOfLast()).toBe(MessageStatus.sending);

      window.dispatchEvent(new Event("online"));
      await vi.waitFor(() => expect(getQueue()).toHaveLength(0));
      expect(statusOfLast()).toBe(MessageStatus.sent);
      scope.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not drop the next queued message when the status update throws", async () => {
    const scope = effectScope();
    const messaging = scope.run(() => useMessages())!;
    await messaging.sendMessage("first");
    await messaging.sendMessage("second");
    const store = useChatStore();
    const spy = vi.spyOn(store, "updateMessageIdAndStatus").mockImplementationOnce(() => { throw new Error("store busy"); });

    online.value = true;
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0));
    expect(sendText.mock.calls.map((c) => c[1])).toEqual(["first", "second"]);
    spy.mockRestore();
    scope.stop();
  });
});
