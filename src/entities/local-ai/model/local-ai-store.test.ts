import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalAiConfig, SqlitePort } from "local-ai";
import {
  FakePlatformSupportAdapter,
  FakeDeviceInfoAdapter,
  FakeLlmRuntimeAdapter,
  FakeAppLifecycleAdapter,
  NodeFsAdapter,
  NodeSqliteAdapter,
  NodeRangeDownloadAdapter,
  SystemClockAdapter,
  WebCryptoHashAdapter,
} from "local-ai/adapters/node-testing";
import { useLocalAiStore, MODEL_DOWNLOADED_MARKER_KEY } from "./local-ai-store";

/** Reuses `local-ai`'s own node-testing fakes (roadmap 2.2) instead of
 *  hand-rolled mocks — a real `LocalAiClient` backed entirely by in-memory/
 *  fake ports, no device/network involved. */
function makeFakeConfig(overrides: Partial<LocalAiConfig> = {}): LocalAiConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "local-ai-store-test-"));
  return {
    manifestUrl: "https://test.invalid/manifest.json",
    ports: {
      platformSupport: new FakePlatformSupportAdapter({
        platform: "android",
        isNative: true,
        availablePlugins: ["LlamaCpp", "CapacitorSQLite", "CapacitorDownloader", "DeviceInfo"],
      }),
      deviceInfo: new FakeDeviceInfoAdapter({
        totalRamGb: 8,
        freeRamGb: 6,
        freeDiskBytes: 10e9,
        thermal: "nominal",
        lowPowerMode: false,
      }),
      downloadTransport: new NodeRangeDownloadAdapter(),
      fileSystem: new NodeFsAdapter(dir),
      sqlite: new NodeSqliteAdapter(":memory:"),
      llmRuntime: new FakeLlmRuntimeAdapter(),
      appLifecycle: new FakeAppLifecycleAdapter(),
      hash: new WebCryptoHashAdapter(),
      clock: new SystemClockAdapter(),
    },
    ...overrides,
  };
}

/** A `SqlitePort` whose every method rejects — simulates a native
 *  `@capacitor-community/sqlite` failure surfacing through `Client.create()`
 *  (`database.migrate()` is the first thing `create()` does). Regression
 *  coverage for a device reporting e.g. "CreateConnection: Connection
 *  local_ai_<address> already exists" / "Already in transaction" from a
 *  stale native connection. */
function makeBrokenSqlitePort(message: string): SqlitePort {
  const fail = () => Promise.reject(new Error(message));
  return { execute: fail, query: fail, transaction: fail, close: fail };
}

/** `LocalAiClient.emit()` is a private instance method — real events (e.g.
 *  `download:progress`) only fire from inside real download/runtime flows,
 *  which need a real manifest+artifact server to exercise end-to-end. Since
 *  what THIS store is responsible for is "did we wire `.on()` correctly",
 *  not "does local-ai emit correctly" (that's the library's own test
 *  suite), invoking the private `emit` directly is a deliberate, narrow
 *  seam — TypeScript `private` has no runtime effect. */
function emitOn(client: unknown, event: string, payload: unknown): Promise<void> {
  return (client as { emit: (e: string, p: unknown) => Promise<void> }).emit(event, payload);
}

describe("useLocalAiStore", () => {
  let store: ReturnType<typeof useLocalAiStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useLocalAiStore();
    window.localStorage.removeItem(MODEL_DOWNLOADED_MARKER_KEY);
  });

  it("checkSupportOnce returns and caches the support report for the session", async () => {
    const platformSupport = new FakePlatformSupportAdapter({
      platform: "android",
      isNative: true,
      availablePlugins: [],
    });

    const report = await store.checkSupportOnce(platformSupport);

    expect(report.isNative).toBe(true);
    expect(store.supportReport).toEqual(report);

    // Cached — a second call with a different override still returns the first report
    const other = new FakePlatformSupportAdapter({ platform: "web", isNative: false, availablePlugins: [] });
    const second = await store.checkSupportOnce(other);
    expect(second).toEqual(report);
  });

  it("ensureClient creates a client once and reuses it for the same address", async () => {
    const config = makeFakeConfig();
    const client1 = await store.ensureClient("addr_a", config);
    const client2 = await store.ensureClient("addr_a", config);

    expect(client1).toBe(client2);
    expect(store.client).toBe(client1);
  });

  it("ensureClient releases the old client and creates a new one on address change", async () => {
    const client1 = await store.ensureClient("addr_a", makeFakeConfig());
    const client2 = await store.ensureClient("addr_b", makeFakeConfig());

    expect(client2).not.toBe(client1);
    expect(store.client).toBe(client2);
  });

  it("concurrent ensureClient() calls for two different addresses never cross-adopt a client", async () => {
    const promiseA = store.ensureClient("addr_a", makeFakeConfig());
    const promiseB = store.ensureClient("addr_b", makeFakeConfig());

    // The later-started call wins deterministically; the earlier one is
    // superseded rather than silently resolving to the wrong account's
    // client (plan §4.2 per-account isolation).
    await expect(promiseA).rejects.toThrow(/superseded/);
    const clientB = await promiseB;

    expect(store.client).toBe(clientB);
    expect(store.client).not.toBeNull();
  });

  it("releaseRuntime() invalidates a still-in-flight ensureClient() creation instead of resurrecting it", async () => {
    const config = makeFakeConfig();
    const creationPromise = store.ensureClient("addr_a", config);

    // Race a releaseRuntime() in before the creation above settles.
    await store.releaseRuntime();
    await expect(creationPromise).rejects.toThrow(/superseded/);

    expect(store.client).toBeNull();
  });

  // Regression: a `Client.create()` failure (e.g. the native SQLite plugin
  // rejecting with "CreateConnection: ... already exists") used to only
  // reach `initError`, silently swallowed by call sites that `.catch()`
  // `downloadModel()`/`ensureClient()` with just a `console.warn` — the
  // download button appeared to "do nothing". `initError` must be set (and
  // `downloadState.model.error` left untouched, since `downloadModel()`'s own
  // try/catch never runs) so the UI has something to render.
  it("ensureClient() failure surfaces into initError, not downloadState.model.error", async () => {
    const base = makeFakeConfig();
    const config: LocalAiConfig = {
      ...base,
      ports: { ...base.ports, sqlite: makeBrokenSqlitePort("CreateConnection: Connection local_ai_addr_a already exists") },
    };

    await expect(store.ensureClient("addr_a", config)).rejects.toThrow(/already exists/);

    expect(store.initError).toMatch(/already exists/);
    expect(store.downloadState.model.error).toBeNull();
    expect(store.client).toBeNull();
  });

  it("downloadModel() propagates an ensureClient() failure instead of silently swallowing it", async () => {
    const base = makeFakeConfig();
    const config: LocalAiConfig = {
      ...base,
      ports: { ...base.ports, sqlite: makeBrokenSqlitePort("Already in transaction") },
    };

    await expect(store.downloadModel("addr_a", config)).rejects.toThrow(/Already in transaction/);

    expect(store.initError).toMatch(/Already in transaction/);
  });

  it("checkEligibility resolves 'unknown' with no cached manifest, without any network call", async () => {
    await store.ensureClient("addr_a", makeFakeConfig());

    const report = await store.checkEligibility("addr_a");

    expect(report.verdict).toBe("unknown");
    expect(store.eligibilityReport).toEqual(report);
  });

  it("propagates download:progress events into reactive downloadState", async () => {
    const client = await store.ensureClient("addr_a", makeFakeConfig());
    const payload = { key: "model__x__v1", kind: "model" as const, percent: 42, status: "downloading" as const };

    await emitOn(client, "download:progress", payload);

    expect(store.downloadState.model.progress).toEqual(payload);
  });

  it("propagates download:completed into modelReady and clears progress/error", async () => {
    const client = await store.ensureClient("addr_a", makeFakeConfig());
    await emitOn(client, "download:progress", { key: "k", kind: "model", percent: 90, status: "downloading" });

    await emitOn(client, "download:completed", { key: "k", kind: "model" });

    expect(store.downloadState.model.ready).toBe(true);
    expect(store.downloadState.model.progress).toBeNull();
    expect(store.modelReady).toBe(true);
    // Persists the device-wide marker `restoreModelIfPreviouslyDownloaded`
    // relies on to skip the download gate on a future session.
    expect(window.localStorage.getItem(MODEL_DOWNLOADED_MARKER_KEY)).toBe("1");
  });

  it("download:completed for the embedding kind does NOT set the model-downloaded marker", async () => {
    const client = await store.ensureClient("addr_a", makeFakeConfig());

    await emitOn(client, "download:completed", { key: "k", kind: "embedding" });

    expect(window.localStorage.getItem(MODEL_DOWNLOADED_MARKER_KEY)).toBeNull();
  });

  it("propagates download:failed into the artifact's error state", async () => {
    const client = await store.ensureClient("addr_a", makeFakeConfig());

    await emitOn(client, "download:failed", { key: "k", kind: "embedding", error: new Error("network down") });

    expect(store.downloadState.embedding.error).toBe("network down");
  });

  it("propagates device:eligibility-warning events into eligibilityReport", async () => {
    const client = await store.ensureClient("addr_a", makeFakeConfig());
    const report = { verdict: "tight" as const, reasons: ["low ram"], device: null };

    await emitOn(client, "device:eligibility-warning", report);

    expect(store.eligibilityReport).toEqual(report);
  });

  it("releaseRuntime clears client + state; a subsequent ensureClient creates a fresh instance", async () => {
    const client1 = await store.ensureClient("addr_a", makeFakeConfig());
    await emitOn(client1, "download:completed", { key: "k", kind: "model" });
    store.isGenerating = true;

    await store.releaseRuntime();

    expect(store.client).toBeNull();
    expect(store.isGenerating).toBe(false);
    expect(store.downloadState.model.ready).toBe(false);
    expect(store.eligibilityReport).toBeNull();

    const client2 = await store.ensureClient("addr_a", makeFakeConfig());
    expect(client2).not.toBe(client1);
  });

  // Regression: `downloadState.model.ready` is in-memory-only and resets on
  // every fresh Pinia store (app restart, logout/login) even though the
  // model file itself is still on disk — without a persisted marker, the
  // download gate would reappear on every session for a model already
  // downloaded (see `restoreModelIfPreviouslyDownloaded`'s doc comment).
  describe("restoreModelIfPreviouslyDownloaded", () => {
    it("does nothing when the device has never completed a download before", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      const spy = vi.spyOn(client, "ensureModelReady");

      await store.restoreModelIfPreviouslyDownloaded("addr_a");

      expect(spy).not.toHaveBeenCalled();
      expect(store.modelReady).toBe(false);
    });

    it("silently restores modelReady when the device-wide marker is set, without a fresh download call", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      const spy = vi.spyOn(client, "ensureModelReady").mockResolvedValue(undefined);
      // Simulates the marker a real download would have left behind in an
      // earlier session — `modelReady` itself starts false this session
      // (fresh Pinia store), same as after an app restart/logout-login.
      window.localStorage.setItem(MODEL_DOWNLOADED_MARKER_KEY, "1");
      expect(store.modelReady).toBe(false);

      await store.restoreModelIfPreviouslyDownloaded("addr_a");

      expect(spy).toHaveBeenCalledTimes(1);
      expect(store.modelReady).toBe(true);
    });

    it("is a no-op once modelReady is already true this session", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      await emitOn(client, "download:completed", { key: "k", kind: "model" });
      const spy = vi.spyOn(client, "ensureModelReady");

      await store.restoreModelIfPreviouslyDownloaded("addr_a");

      expect(spy).not.toHaveBeenCalled();
    });
  });
});
