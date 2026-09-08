import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { initChatDb, closeChatDb } from "../index";
import { SyncEngine } from "../sync-engine";
import {
  signalChatsInteractive,
  __resetBootSignalsForTests,
} from "@/shared/lib/boot-signals";

// SyncEngine/DecryptionWorker construction touches the Matrix service —
// stub it the same way the other sync-engine tests do.
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => ({
    isReady: () => true,
    sendEncryptedText: vi.fn(() => "$evt_server"),
    sendText: vi.fn(() => "$evt_server"),
    uploadContentMxc: vi.fn(() => "mxc://s/u"),
  }),
}));

const getRoomCrypto = async () => undefined;

let userCounter = 0;
const freshUserId = () => `dispose-test-user-${++userCounter}`;

describe("SyncEngine watchdog leak on logout / account switch", () => {
  beforeEach(() => {
    __resetBootSignalsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    closeChatDb();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("closeChatDb() stops the previous SyncEngine's watchdog interval", async () => {
    const disposeSpy = vi.spyOn(SyncEngine.prototype, "dispose");

    initChatDb(freshUserId(), getRoomCrypto);
    signalChatsInteractive();
    await vi.advanceTimersByTimeAsync(1_000);

    closeChatDb();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("switching users disposes the previous user's SyncEngine, not just the DecryptionWorker", async () => {
    const disposeSpy = vi.spyOn(SyncEngine.prototype, "dispose");

    initChatDb(freshUserId(), getRoomCrypto);
    signalChatsInteractive();
    await vi.advanceTimersByTimeAsync(1_000);

    // Switching to a different user closes the previous kit before opening
    // the new one — the previous SyncEngine's watchdog must not survive.
    initChatDb(freshUserId(), getRoomCrypto);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("without disposal the watchdog would keep ticking — guard against regression via timer count", async () => {
    const watchdogSpy = vi.spyOn(
      SyncEngine.prototype as unknown as { watchdogCheck: () => Promise<void> },
      "watchdogCheck",
    ).mockResolvedValue(undefined);

    initChatDb(freshUserId(), getRoomCrypto);
    signalChatsInteractive();
    await vi.advanceTimersByTimeAsync(0);

    closeChatDb();
    const callsRightAfterClose = watchdogSpy.mock.calls.length;

    // Advance well past several watchdog intervals (30s each) — if the
    // interval were still alive, watchdogCheck would keep firing.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(watchdogSpy.mock.calls.length).toBe(callsRightAfterClose);
  });
});
