import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { effectScope } from "vue";

/**
 * Regression for issues #290–300 and #312:
 *
 * A single AES-SIV decryption failure produced 12 identical bug-reports —
 * one per download retry / re-mount / visibilitychange re-attempt. The
 * automatic bug-report stream in `useFileDownload.download` had no dedup
 * and treated every catch as a new actionable bug, drowning real signal
 * in noise.
 *
 * Two layers of fix:
 *   1) Blacklist: AES-SIV / crypto-failure errors are user-actionable
 *      ("ask the sender to resend"), not a code defect. They MUST NOT
 *      open the bug-report modal automatically.
 *   2) Dedup window: identical (messageId, errorHash) pairs within the
 *      window emit at most ONE bug-report.
 */

vi.mock("@/shared/lib/platform", () => ({
  get isNative() { return false; },
  get isElectron() { return false; },
}));

// --- Bug report mock — STABLE singleton so we can verify call counts ---
const bugReportOpen: Mock = vi.fn();
vi.mock("@/features/bug-report", () => ({
  useBugReport: vi.fn(() => ({ open: bugReportOpen })),
}));

vi.mock("@/shared/lib/i18n", () => ({
  tRaw: (k: string) => k,
}));

// --- Auth store: provides a fake pcrypto with controllable decryptKey ---
const decryptKeyMock: Mock = vi.fn();
const decryptFileMock: Mock = vi.fn();
vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(() => ({
    pcrypto: {
      rooms: {
        "!room:server": {
          decryptKey: decryptKeyMock,
          decryptFile: decryptFileMock,
        },
      },
    },
  })),
}));

vi.mock("@/shared/lib/matrix/functions", () => ({
  hexEncode: vi.fn((s: string) => s),
}));

const { useFileDownload, revokeAllFileUrls, _resetBugReportDedupForTests } =
  await import("./use-file-download");

interface FakeMessage {
  id: string;
  _key: string;
  roomId: string;
  senderId: string;
  content: string;
  timestamp: number;
  status: string;
  type: string;
  fileInfo: {
    name: string;
    type: string;
    size: number;
    url: string;
    secrets: { keys: string; block: number; v: number };
  };
}

function makeMessage(overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id: "$evt-aes-1",
    _key: "client-1",
    roomId: "!room:server",
    senderId: "@alice:server",
    content: "secret.pdf",
    timestamp: 1_700_000_000_000,
    status: "sent",
    type: "file",
    fileInfo: {
      name: "secret.pdf",
      type: "application/pdf",
      size: 1024,
      url: "https://example.com/secret.pdf",
      secrets: { keys: "deadbeef", block: 100, v: 1 },
    },
    ...overrides,
  };
}

/** Run a download promise and flush all retry timers (RETRY_DELAYS = 1s/3s/6s).
 *  Without this, the test waits 10 real seconds and times out. */
async function runWithFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  const promise = fn();
  // Drain microtasks first so the retry loop reaches the setTimeout.
  await Promise.resolve();
  await vi.runAllTimersAsync();
  return promise;
}

describe("useFileDownload — auto bug-report blacklist & dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeAllFileUrls();
    _resetBugReportDedupForTests();
    vi.useFakeTimers();
    // Default: fetch succeeds with an encrypted blob.
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])),
      }),
    ) as unknown as Mock;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT auto-open bug-report when decryptKey throws AES-SIV ciphertext error", async () => {
    decryptKeyMock.mockRejectedValue(
      new Error("AES-SIV: ciphertext verification failure!"),
    );

    const scope = effectScope();
    await scope.run(async () => {
      const { download } = useFileDownload();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await runWithFakeTimers(() => download(makeMessage() as any));
    });
    scope.stop();

    expect(bugReportOpen).not.toHaveBeenCalled();
  });

  it("does NOT auto-open bug-report when error message includes 'ciphertext verification'", async () => {
    decryptKeyMock.mockRejectedValue(
      new Error("ciphertext verification failed mid-stream"),
    );

    const scope = effectScope();
    await scope.run(async () => {
      const { download } = useFileDownload();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await runWithFakeTimers(() => download(makeMessage({ id: "$evt-aes-2", _key: "client-2" }) as any));
    });
    scope.stop();

    expect(bugReportOpen).not.toHaveBeenCalled();
  });

  it("fast-fails on crypto errors (no 3-retry / 10s spinner)", async () => {
    // Crypto failures are deterministic for a given ciphertext + key set.
    // The retry loop must NOT call decryptKey 4 times (attempt 0 + 3 retries)
    // — that produces a 10-second spinner with no chance of recovery.
    decryptKeyMock.mockRejectedValue(
      new Error("AES-SIV: ciphertext verification failure!"),
    );

    const scope = effectScope();
    await scope.run(async () => {
      const { download } = useFileDownload();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await runWithFakeTimers(() => download(makeMessage({ id: "$evt-fast", _key: "client-fast" }) as any));
    });
    scope.stop();

    // Exactly 1 attempt: the fast-fail short-circuits the retry loop.
    expect(decryptKeyMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-open bug-report when error message says 'emptyforme' (sender lacks our keys)", async () => {
    decryptKeyMock.mockRejectedValue(new Error("emptyforme"));

    const scope = effectScope();
    await scope.run(async () => {
      const { download } = useFileDownload();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await runWithFakeTimers(() => download(makeMessage({ id: "$evt-aes-3", _key: "client-3" }) as any));
    });
    scope.stop();

    expect(bugReportOpen).not.toHaveBeenCalled();
  });

  it("emits exactly ONE bug-report when the same message fails 5 times with the same generic error", async () => {
    // Generic non-crypto error (e.g. quota exceeded) — eligible for auto-report.
    global.fetch = vi.fn(() => Promise.reject(new Error("QuotaExceeded"))) as unknown as Mock;

    const scope = effectScope();
    await scope.run(async () => {
      const { download } = useFileDownload();
      const msg = makeMessage({
        id: "$evt-quota",
        _key: "client-quota",
        fileInfo: {
          name: "x.bin",
          type: "application/octet-stream",
          size: 1,
          url: "https://example.com/x.bin",
          secrets: { keys: "x", block: 1, v: 1 },
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = msg as any;
      // 5 sequential failed attempts for the SAME message+error.
      // Need to clear state.error between attempts since download bails fast on existing error state.
      const { getState } = useFileDownload();
      for (let i = 0; i < 5; i++) {
        getState(msg._key).error = null;
        getState(msg._key).loading = false;
        await runWithFakeTimers(() => download(m));
      }
    });
    scope.stop();

    expect(bugReportOpen).toHaveBeenCalledTimes(1);
  });

  it("emits a SECOND bug-report after the dedup window (5 minutes) elapses", async () => {
    vi.setSystemTime(new Date("2026-04-29T10:00:00Z"));

    global.fetch = vi.fn(() => Promise.reject(new Error("QuotaExceeded"))) as unknown as Mock;

    const scope = effectScope();
    await scope.run(async () => {
      const { download, getState } = useFileDownload();
      const msg = makeMessage({
        id: "$evt-window",
        _key: "client-window",
        fileInfo: {
          name: "x.bin",
          type: "application/octet-stream",
          size: 1,
          url: "https://example.com/x.bin",
          secrets: { keys: "x", block: 1, v: 1 },
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = msg as any;

      getState(msg._key).error = null;
      getState(msg._key).loading = false;
      await runWithFakeTimers(() => download(m));
      expect(bugReportOpen).toHaveBeenCalledTimes(1);

      // Advance > 5 minutes (Date.now() needs to move past the dedup window)
      vi.setSystemTime(new Date("2026-04-29T10:06:00Z"));

      getState(msg._key).error = null;
      getState(msg._key).loading = false;
      await runWithFakeTimers(() => download(m));
      expect(bugReportOpen).toHaveBeenCalledTimes(2);
    });
    scope.stop();
  });
});

describe("useFileDownload — errorKind on state for UI branching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeAllFileUrls();
    _resetBugReportDedupForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets state.errorKind = 'crypto' when decryptKey throws AES-SIV failure", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])),
      }),
    ) as unknown as Mock;
    decryptKeyMock.mockRejectedValue(
      new Error("AES-SIV: ciphertext verification failure!"),
    );

    const scope = effectScope();
    await scope.run(async () => {
      const { download, getState } = useFileDownload();
      const msg = makeMessage({ id: "$evt-kind-1", _key: "client-kind-1" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await runWithFakeTimers(() => download(msg as any));
      const state = getState(msg._key);
      expect(state.errorKind).toBe("crypto");
    });
    scope.stop();
  });

  it("sets state.errorKind = 'network' when fetch fails with 5xx", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        blob: () => Promise.resolve(new Blob()),
      }),
    ) as unknown as Mock;

    const scope = effectScope();
    await scope.run(async () => {
      const { download, getState } = useFileDownload();
      const msg = makeMessage({ id: "$evt-kind-2", _key: "client-kind-2" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await runWithFakeTimers(() => download(msg as any));
      const state = getState(msg._key);
      expect(state.errorKind).toBe("network");
    });
    scope.stop();
  });
});
