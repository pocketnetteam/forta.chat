/**
 * Regression (audit A5): EncryptedMessageNotice auto-retried in onMounted
 * with a one-shot flag — opening a room with N stuck messages fired N
 * concurrent decrypts regardless of visibility, and one failure disabled
 * auto-retry for the component's lifetime. Auto-retry is now driven by
 * IntersectionObserver through a bounded scheduler with a failure cooldown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { MessageStatus, MessageType } from "@/entities/chat/model/types";
import type { Message } from "@/entities/chat/model/types";

const retryMessageDecryption = vi.fn<(eventId: string) => Promise<boolean>>();

vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({ retryMessageDecryption }),
}));

// useI18n is auto-imported from this module (unplugin-auto-import), not a global.
vi.mock("@/shared/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/i18n")>()),
  useI18n: () => ({ t: (k: string) => k }),
}));

type IOCallback = (entries: Array<Pick<IntersectionObserverEntry, "isIntersecting">>) => void;
let observers: Array<{ callback: IOCallback; disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }> = [];

class MockIntersectionObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
  constructor(callback: IOCallback) {
    observers.push({ callback, disconnect: this.disconnect, observe: this.observe });
  }
}

let idSeq = 0;
function makeMessage(overrides: Partial<Message> = {}): Message {
  // Unique ids per test — the scheduler is an app-wide singleton that
  // remembers failure cooldowns per eventId.
  idSeq++;
  return {
    id: `$enc${idSeq}`,
    roomId: "!r:s",
    senderId: "peer",
    content: "[encrypted]",
    timestamp: 1000,
    status: MessageStatus.sent,
    type: MessageType.text,
    decryptionStatus: "pending",
    ...overrides,
  } as Message;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function mountNotice(message: Message) {
  const { default: EncryptedMessageNotice } = await import("../EncryptedMessageNotice.vue");
  return mount(EncryptedMessageNotice, { props: { message } });
}

function becomeVisible(i = observers.length - 1, visible = true) {
  observers[i].callback([{ isIntersecting: visible }]);
}

describe("EncryptedMessageNotice auto-retry", () => {
  beforeEach(() => {
    observers = [];
    retryMessageDecryption.mockReset();
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not attempt a decrypt on mount while the bubble is off-screen", async () => {
    await mountNotice(makeMessage());
    await flush();
    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledTimes(1);
    expect(retryMessageDecryption).not.toHaveBeenCalled();
  });

  it("attempts once the bubble scrolls into view", async () => {
    retryMessageDecryption.mockResolvedValue(true);
    const msg = makeMessage();
    await mountNotice(msg);

    becomeVisible(0, false);
    await flush();
    expect(retryMessageDecryption).not.toHaveBeenCalled();

    becomeVisible();
    await flush();
    expect(retryMessageDecryption).toHaveBeenCalledWith(msg.id);
  });

  it("retries again on re-entry after the failure cooldown (no one-shot flag)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    retryMessageDecryption.mockResolvedValue(false);
    await mountNotice(makeMessage());

    becomeVisible();
    await flush();
    expect(retryMessageDecryption).toHaveBeenCalledTimes(1);

    // Scroll jitter inside the cooldown must not hammer the worker.
    becomeVisible();
    await flush();
    expect(retryMessageDecryption).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + 10_001);
    becomeVisible();
    await flush();
    expect(retryMessageDecryption).toHaveBeenCalledTimes(2);
  });

  it("limits concurrent automatic attempts when many bubbles become visible", async () => {
    const pending: Array<(ok: boolean) => void> = [];
    retryMessageDecryption.mockImplementation(() => new Promise<boolean>((r) => pending.push(r)));

    for (let i = 0; i < 6; i++) await mountNotice(makeMessage());
    for (let i = 0; i < observers.length; i++) becomeVisible(i);
    await flush();
    expect(retryMessageDecryption).toHaveBeenCalledTimes(2);

    pending.shift()!(true);
    await flush();
    expect(retryMessageDecryption).toHaveBeenCalledTimes(3);

    // Drain the rest so the shared scheduler is idle for later tests.
    while (pending.length > 0) {
      pending.shift()!(true);
      await flush();
    }
  });

  it("manual refresh bypasses the auto-retry cooldown", async () => {
    retryMessageDecryption.mockResolvedValue(false);
    const wrapper = await mountNotice(makeMessage());

    becomeVisible();
    await flush();
    expect(retryMessageDecryption).toHaveBeenCalledTimes(1);

    await wrapper.find("button").trigger("click");
    await flush();
    expect(retryMessageDecryption).toHaveBeenCalledTimes(2);
  });

  it("never auto-attempts for a local (non-$) id and disconnects on unmount", async () => {
    const wrapper = await mountNotice(makeMessage({ id: "c_local" }));
    becomeVisible();
    await flush();
    expect(retryMessageDecryption).not.toHaveBeenCalled();

    wrapper.unmount();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });
});
