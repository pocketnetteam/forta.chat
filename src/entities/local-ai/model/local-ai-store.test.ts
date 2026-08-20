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

  // Regression: chunked Range requests (CapacitorRangeDownloadAdapter) can
  // take a couple of seconds before their first real onProgress tick — the
  // "Скачать" button looked unresponsive for that whole window. Call sites
  // (AiModelGate.vue/LocalAiSettingsSection.vue) call this synchronously
  // before awaiting downloadModel(), so isDownloading flips true on the same
  // tick as the tap.
  it("markDownloadStarting() flips downloadState.model.progress to a non-null 0% placeholder immediately", () => {
    expect(store.downloadState.model.progress).toBeNull();

    store.markDownloadStarting();

    expect(store.downloadState.model.progress).toEqual({ key: "model", kind: "model", percent: 0, status: "pending" });
  });

  // Regression: pressing "Докачать модель (X%)" visibly restarted the
  // progress bar from 0% for the couple of seconds before the transport's
  // first real tick caught back up to where the resume actually was —
  // the resume itself was already byte-correct, only the DISPLAY lied.
  it("markDownloadStarting() seeds the placeholder from partialDownload's percent, not a hardcoded 0", async () => {
    const client = await store.ensureClient("addr_a", makeFakeConfig());
    vi.spyOn(client, "getDownloadProgress").mockResolvedValue({ bytesDownloaded: 30, sizeBytesExpected: 100, percent: 30 });
    await store.checkPartialDownload("addr_a");

    store.markDownloadStarting();

    expect(store.downloadState.model.progress).toEqual({ key: "model", kind: "model", percent: 30, status: "pending" });
  });

  it("markDownloadStarting()'s placeholder is overwritten by the first real download:progress event", async () => {
    const client = await store.ensureClient("addr_a", makeFakeConfig());
    store.markDownloadStarting();

    await emitOn(client, "download:progress", { key: "model__x__v1", kind: "model", percent: 3, status: "downloading" });

    expect(store.downloadState.model.progress).toEqual({ key: "model__x__v1", kind: "model", percent: 3, status: "downloading" });
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

  // Regression coverage for forta.chat's Settings → Local AI pause/resume/
  // delete buttons (docs/decisions.md, 2026-08-19). `local-ai` itself never
  // surfaces "paused" through download:progress (the transport's pause()
  // deliberately fires no event at all) — isPaused is store-only state.
  describe("pauseDownload/resumeDownload", () => {
    it("pauseDownload() calls client.pauseModelDownload() and sets isPaused", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      const spy = vi.spyOn(client, "pauseModelDownload").mockResolvedValue(undefined);

      await store.pauseDownload("addr_a");

      expect(spy).toHaveBeenCalledTimes(1);
      expect(store.isPaused).toBe(true);
    });

    it("resumeDownload() calls client.resumeModelDownload() and clears isPaused synchronously, before the call resolves", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      let resolveResume!: () => void;
      const spy = vi
        .spyOn(client, "resumeModelDownload")
        .mockReturnValue(new Promise((resolve) => (resolveResume = resolve)));
      store.isPaused = true;

      const resumePromise = store.resumeDownload("addr_a");
      expect(store.isPaused).toBe(false); // flips immediately, doesn't wait for the transport call

      resolveResume();
      await resumePromise;
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("a real download:progress tick clears isPaused even without resumeDownload() being called", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      store.isPaused = true;

      await emitOn(client, "download:progress", { key: "k", kind: "model", percent: 10, status: "downloading" });

      expect(store.isPaused).toBe(false);
    });

    it("download:completed and download:failed for the model both clear isPaused", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      store.isPaused = true;
      await emitOn(client, "download:completed", { key: "k", kind: "model" });
      expect(store.isPaused).toBe(false);

      store.isPaused = true;
      await emitOn(client, "download:failed", { kind: "model", error: new Error("network") });
      expect(store.isPaused).toBe(false);
    });

    it("releaseRuntime() resets isPaused", async () => {
      await store.ensureClient("addr_a", makeFakeConfig());
      store.isPaused = true;

      await store.releaseRuntime();

      expect(store.isPaused).toBe(false);
    });
  });

  // Regression: a real network drop mid-download exhausted DownloadEngine's
  // retries and left the UI with a stale progress bar + a raw, untranslated
  // exception message and no actionable button — download:failed only ever
  // set `.error`, never cleared `.progress` (so isDownloading stayed true
  // forever) and never carried a code the UI could translate.
  describe("download failure recovery", () => {
    it("download:failed carries the error's .code into errorCode", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      const err = Object.assign(new Error("download failed after 5 attempts"), { code: "download_failed" });

      await emitOn(client, "download:failed", { kind: "model", error: err });

      expect(store.downloadState.model.error).toBe("download failed after 5 attempts");
      expect(store.downloadState.model.errorCode).toBe("download_failed");
    });

    it("download:failed for the model clears progress, so isDownloading-gated UI (the resume button) reappears", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      await emitOn(client, "download:progress", { key: "k", kind: "model", percent: 45, status: "downloading" });
      expect(store.downloadState.model.progress).not.toBeNull();

      await emitOn(client, "download:failed", { kind: "model", error: new Error("network down") });

      expect(store.downloadState.model.progress).toBeNull();
    });

    it("download:failed for the model re-reads getDownloadProgress() so partialDownload reflects bytes already on disk", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      vi.spyOn(client, "getDownloadProgress").mockResolvedValue({ bytesDownloaded: 45, sizeBytesExpected: 100, percent: 45 });

      await emitOn(client, "download:failed", { kind: "model", error: new Error("network down") });
      // applyDownloadFailure()'s getDownloadProgress() refresh is a
      // fire-and-forget .then() chain, not awaited by the event handler
      // itself — flush the macrotask queue so it's had a chance to settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(store.partialDownload).toEqual({ bytesDownloaded: 45, sizeBytesExpected: 100, percent: 45 });
    });

    it("download:failed for the embedding does not touch partialDownload (model-only)", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      const spy = vi.spyOn(client, "getDownloadProgress");

      await emitOn(client, "download:failed", { kind: "embedding", error: new Error("network down") });

      expect(spy).not.toHaveBeenCalled();
    });

    it("downloadModel()'s own catch sets errorCode too, for a failure before any download:failed event fires (e.g. eligibility check)", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      const err = Object.assign(new Error("device not eligible"), { code: "device_not_eligible" });
      vi.spyOn(client, "ensureModelReady").mockRejectedValue(err);

      await expect(store.downloadModel("addr_a")).rejects.toThrow("device not eligible");

      expect(store.downloadState.model.errorCode).toBe("device_not_eligible");
      expect(store.downloadState.model.progress).toBeNull();
    });

    // Regression: observed live (2026-08-19) that the automatic background
    // restoreModelIfPreviouslyDownloaded() check and an explicit user tap
    // can both call downloadModel() within the same narrow window — the
    // button hadn't disappeared yet because the silent restore call hadn't
    // resolved. A stale error from one of those calls could sit in the
    // store even after the OTHER one reached ready, showing "download
    // failed" right next to a fully populated, working model card.
    it("downloadModel() clears a stale error at its success point too, not just at its own start", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      vi.spyOn(client, "ensureModelReady").mockImplementation(async () => {
        // Simulates a concurrent call's failure landing while this one is
        // still in flight — this call's own initial reset (at the top of
        // downloadModel()) already ran and can't see this.
        store.downloadState.model.error = "a concurrent call's stale error";
        store.downloadState.model.errorCode = "download_failed";
      });

      await store.downloadModel("addr_a");

      expect(store.modelReady).toBe(true);
      expect(store.downloadState.model.error).toBeNull();
      expect(store.downloadState.model.errorCode).toBeNull();
    });
  });

  // Regression coverage for the "Удалить модель" button — LocalAiClient has
  // no delete API until 2026-08-19 (docs/decisions.md); this is the store's
  // side of wiring the new pauseModelDownload/resumeModelDownload/
  // deleteModel() methods in.
  describe("deleteModel", () => {
    it("calls client.deleteModel() and resets downloadState.model, partialDownload, and isPaused", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      const spy = vi.spyOn(client, "deleteModel").mockResolvedValue(undefined);
      await emitOn(client, "download:completed", { key: "k", kind: "model" });
      vi.spyOn(client, "getDownloadProgress").mockResolvedValue({ bytesDownloaded: 1, sizeBytesExpected: 2, percent: 50 });
      await store.checkPartialDownload("addr_a");
      store.isPaused = true;
      expect(store.modelReady).toBe(true);

      await store.deleteModel("addr_a");

      expect(spy).toHaveBeenCalledTimes(1);
      expect(store.modelReady).toBe(false);
      expect(store.downloadState.model.progress).toBeNull();
      expect(store.partialDownload).toBeNull();
      expect(store.isPaused).toBe(false);
    });

    // Regression: MODEL_DOWNLOADED_MARKER_KEY drove a silent
    // restoreModelIfPreviouslyDownloaded() on the next app launch — without
    // clearing it, a deliberately-deleted model would silently come back.
    it("clears MODEL_DOWNLOADED_MARKER_KEY so a later restoreModelIfPreviouslyDownloaded() stays a no-op", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      vi.spyOn(client, "deleteModel").mockResolvedValue(undefined);
      window.localStorage.setItem(MODEL_DOWNLOADED_MARKER_KEY, "1");

      await store.deleteModel("addr_a");

      expect(window.localStorage.getItem(MODEL_DOWNLOADED_MARKER_KEY)).toBeNull();
      const restoreSpy = vi.spyOn(client, "ensureModelReady");
      await store.restoreModelIfPreviouslyDownloaded("addr_a");
      expect(restoreSpy).not.toHaveBeenCalled();
    });
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

  // Regression: an interrupted download resumes correctly at the transport
  // level (CapacitorRangeDownloadAdapter), but nothing in the UI could tell
  // the difference from a fresh download — read as "resume doesn't work"
  // when it actually did (docs/plans/llama2/decisions.md).
  describe("checkPartialDownload", () => {
    it("reads getDownloadProgress('model') into partialDownload", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      const progress = { bytesDownloaded: 512, sizeBytesExpected: 2048, percent: 25 };
      vi.spyOn(client, "getDownloadProgress").mockResolvedValue(progress);

      await store.checkPartialDownload("addr_a");

      expect(store.partialDownload).toEqual(progress);
    });

    it("leaves partialDownload null when there's nothing to resume (no manifest cached / no partial file)", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      vi.spyOn(client, "getDownloadProgress").mockResolvedValue(null);

      await store.checkPartialDownload("addr_a");

      expect(store.partialDownload).toBeNull();
    });

    it("markDownloadStarting() clears a stale partialDownload once the live progress bar takes over", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      vi.spyOn(client, "getDownloadProgress").mockResolvedValue({ bytesDownloaded: 1, sizeBytesExpected: 2, percent: 50 });
      await store.checkPartialDownload("addr_a");
      expect(store.partialDownload).not.toBeNull();

      store.markDownloadStarting();

      expect(store.partialDownload).toBeNull();
    });

    it("download:completed for the model clears partialDownload", async () => {
      const client = await store.ensureClient("addr_a", makeFakeConfig());
      vi.spyOn(client, "getDownloadProgress").mockResolvedValue({ bytesDownloaded: 1, sizeBytesExpected: 2, percent: 50 });
      await store.checkPartialDownload("addr_a");

      await emitOn(client, "download:completed", { key: "k", kind: "model" });

      expect(store.partialDownload).toBeNull();
    });
  });
});
