import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalAiConfig } from "local-ai";
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
import { useLocalAiStore } from "./local-ai-store";

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
});
