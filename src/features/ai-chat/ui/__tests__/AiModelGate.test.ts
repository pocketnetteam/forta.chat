import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import AiModelGate from "../AiModelGate.vue";

// Regression: an `ensureClient()` failure (e.g. the native SQLite plugin
// rejecting with "CreateConnection: ... already exists") only ever reached
// `localAiStore.initError` — `downloadState.model.error` stayed untouched
// since `downloadModel()`'s own try/catch never runs — and the view's
// `.catch(() => console.warn(...))` swallowed it, so the "Скачать" button
// appeared to just do nothing. The gate must render `initError` too.
const fakeLocalAiStore = reactive({
  supportReport: { isNative: true, capabilities: { inference: true } } as {
    isNative: boolean;
    capabilities: { inference: boolean };
  } | null,
  eligibilityReport: null as { verdict: "ok" | "tight" | "no" | "unknown" } | null,
  downloadState: {
    model: { error: null as string | null, errorCode: null as string | null, progress: null as { percent: number; status?: string } | null },
  },
  modelReady: false,
  initError: null as string | null,
  checkSupportOnce: vi.fn(async () => {}),
  refreshManifest: vi.fn(async () => {}),
  checkEligibility: vi.fn(async () => {}),
  restoreModelIfPreviouslyDownloaded: vi.fn(async () => {}),
  partialDownload: null as { percent: number } | null,
  checkPartialDownload: vi.fn(async () => {}),
  markDownloadStarting: vi.fn(() => {}),
  downloadModel: vi.fn(async () => {}),
  isPaused: false,
  pauseDownload: vi.fn(async () => {}),
  resumeDownload: vi.fn(async () => {}),
});

// Imports downloadErrorMessage directly from its own file (not the
// "@/entities/local-ai" barrel) inside the factory — the barrel's
// create-client.ts pulls in native-foreground-download.adapter.ts, which
// calls registerPlugin() from @capacitor/core at module-eval time, and a
// factory can't reference a top-level `import` binding anyway (hoisting —
// vi.mock factories run before imports are initialized). This file has no
// such side effects, so the real (pure) mapping is used instead of a
// hand-rolled duplicate.
vi.mock("@/entities/local-ai", async () => {
  const { downloadErrorMessage } = await import("@/entities/local-ai/lib/download-error-message");
  const { downloadPhaseLabel } = await import("@/entities/local-ai/lib/download-phase-label");
  return {
    useLocalAiStore: () => fakeLocalAiStore,
    downloadErrorMessage,
    downloadPhaseLabel,
  };
});

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ address: "addr_a" }),
}));

// Mirrors GroupCreationPanel.i18n.test.ts's pattern: a real template string
// per key (so `{error}` placeholder substitution is actually exercised),
// not just the raw key echoed back.
const dict: Record<string, string> = {
  "ai.initError": "Failed to prepare the AI engine: {error}",
  "ai.pause": "Pause",
  "ai.resume": "Resume",
  "ai.downloading": "Downloading… {percent}%",
  "ai.downloadPaused": "Paused… {percent}%",
  "ai.verifying": "Verifying file… {percent}%",
  "ai.loadingModel": "Loading model into memory…",
  "ai.downloadErrorGeneric": "Couldn't download the model. Check your internet connection and tap Resume.",
  "ai.downloadErrorChecksum": "The downloaded file was corrupted. Try downloading the model again.",
  "ai.downloadErrorStorage": "Not enough storage space on this device to download the model.",
};

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const text = dict[key] ?? key;
      if (!params) return text;
      return Object.entries(params).reduce(
        (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, "g"), String(v)),
        text,
      );
    },
  }),
}));

beforeEach(() => {
  fakeLocalAiStore.supportReport = { isNative: true, capabilities: { inference: true } };
  fakeLocalAiStore.eligibilityReport = null;
  fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: null } };
  fakeLocalAiStore.modelReady = false;
  fakeLocalAiStore.initError = null;
  fakeLocalAiStore.partialDownload = null;
  fakeLocalAiStore.isPaused = false;
  vi.clearAllMocks();
  // vi.clearAllMocks() clears call history but NOT a custom
  // mockImplementation() set by an earlier test — reset the two mocks tests
  // in this file override with side effects back to safe no-ops explicitly,
  // or a later "baseline" test can flakily inherit a previous test's override.
  fakeLocalAiStore.checkPartialDownload.mockImplementation(async () => {});
  fakeLocalAiStore.restoreModelIfPreviouslyDownloaded.mockImplementation(async () => {});
});

describe("AiModelGate", () => {
  it("renders initError when ensureClient() failed and downloadState.error was never set", async () => {
    fakeLocalAiStore.initError = "CreateConnection: Connection local_ai_addr_a already exists";

    const wrapper = mount(AiModelGate);
    await flushPromises();

    expect(wrapper.text()).toContain("Failed to prepare the AI engine: CreateConnection: Connection local_ai_addr_a already exists");
    // The download button must still be present/clickable — this isn't a
    // dead end, the user can retry.
    expect(wrapper.find("button").exists()).toBe(true);
  });

  it("prefers downloadState.error over initError when both are set", async () => {
    fakeLocalAiStore.downloadState = { model: { error: "download-specific failure", errorCode: null, progress: null } };
    fakeLocalAiStore.initError = "stale init error from an earlier attempt";

    const wrapper = mount(AiModelGate);
    await flushPromises();

    // The raw message ("download-specific failure") is never shown directly
    // — only the translated, human-readable text mapped from errorCode.
    expect(wrapper.text()).toContain("Couldn't download the model. Check your internet connection and tap Resume.");
    expect(wrapper.text()).not.toContain("download-specific failure");
    expect(wrapper.text()).not.toContain("stale init error from an earlier attempt");
  });

  // Regression: a real network drop mid-download exhausted DownloadEngine's
  // retries and left the UI showing a stale progress bar + non-functional
  // "Пауза" button alongside the error text, with no actionable button at
  // all — isDownloading (progress !== null) never flipped false, so the
  // Скачать/Докачать button (gated behind !isDownloading) never reappeared.
  describe("download failure recovery", () => {
    it("clears isDownloading once an error is set, so the download/resume button reappears", async () => {
      fakeLocalAiStore.downloadState = {
        model: { error: "download of model__x__v1.gguf failed after 5 attempts: network error", errorCode: "download_failed", progress: null },
      };

      const wrapper = mount(AiModelGate);
      await flushPromises();

      const button = wrapper.find("button");
      expect(button.exists()).toBe(true);
      expect(button.text()).not.toBe("Pause");
    });

    it("maps errorCode 'checksum_mismatch' to the checksum-specific message", async () => {
      fakeLocalAiStore.downloadState = { model: { error: "sha256 mismatch", errorCode: "checksum_mismatch", progress: null } };

      const wrapper = mount(AiModelGate);
      await flushPromises();

      expect(wrapper.text()).toContain("The downloaded file was corrupted. Try downloading the model again.");
    });

    it("maps errorCode 'insufficient_storage' to the storage-specific message", async () => {
      fakeLocalAiStore.downloadState = { model: { error: "insufficient storage", errorCode: "insufficient_storage", progress: null } };

      const wrapper = mount(AiModelGate);
      await flushPromises();

      expect(wrapper.text()).toContain("Not enough storage space on this device to download the model.");
    });

    it("shows a resume-labeled button when partialDownload has real bytes after a failure", async () => {
      fakeLocalAiStore.downloadState = { model: { error: "network drop", errorCode: "download_failed", progress: null } };
      fakeLocalAiStore.partialDownload = { percent: 33 };

      const wrapper = mount(AiModelGate);
      await flushPromises();

      expect(wrapper.find("button").text()).toContain("ai.resumeDownload");
    });
  });

  it("renders neither error message when there is no failure", async () => {
    const wrapper = mount(AiModelGate);
    await flushPromises();

    expect(wrapper.find(".text-color-bad").exists()).toBe(false);
  });

  // Regression: checkEligibility() only ever reads whatever manifest is
  // already cached — without refreshing first, the eligibility badge flashed
  // "Не удалось определить..." on every first-ever mount even on a device
  // with a fine connection, since no manifest had been fetched yet.
  it("refreshes the manifest before checking eligibility on mount", async () => {
    const callOrder: string[] = [];
    fakeLocalAiStore.refreshManifest.mockImplementation(async () => {
      callOrder.push("refreshManifest");
    });
    fakeLocalAiStore.checkEligibility.mockImplementation(async () => {
      callOrder.push("checkEligibility");
    });

    mount(AiModelGate);
    await flushPromises();

    expect(fakeLocalAiStore.refreshManifest).toHaveBeenCalledWith("addr_a");
    expect(callOrder).toEqual(["refreshManifest", "checkEligibility"]);
  });

  // Regression: an interrupted download resumes correctly at the transport
  // level (CapacitorRangeDownloadAdapter), but the button always read
  // "Скачать модель" regardless — indistinguishable from a fresh download,
  // reported as "resume doesn't work" when it actually did.
  it("checks for a partial download on mount and labels the button 'resume' when one exists", async () => {
    fakeLocalAiStore.checkPartialDownload.mockImplementation(async () => {
      fakeLocalAiStore.partialDownload = { percent: 42 };
    });

    const wrapper = mount(AiModelGate);
    await flushPromises();

    expect(fakeLocalAiStore.checkPartialDownload).toHaveBeenCalledWith("addr_a");
    expect(wrapper.find("button").text()).toContain("ai.resumeDownload");
    expect(wrapper.find("button").text()).not.toBe("ai.download");
  });

  it("labels the button as a fresh download when there is no partial download", async () => {
    const wrapper = mount(AiModelGate);
    await flushPromises();

    expect(wrapper.find("button").text()).toBe("ai.download");
  });

  it("does not check for a partial download once the model is already ready (nothing to resume)", async () => {
    fakeLocalAiStore.restoreModelIfPreviouslyDownloaded.mockImplementation(async () => {
      fakeLocalAiStore.modelReady = true;
    });

    mount(AiModelGate);
    await flushPromises();

    expect(fakeLocalAiStore.checkPartialDownload).not.toHaveBeenCalled();
  });

  // Regression: chunked Range downloads can take a couple of seconds before
  // their first onProgress tick — tapping "Скачать" otherwise looked like it
  // did nothing for that whole window.
  it("marks the download as starting synchronously before awaiting downloadModel()", async () => {
    const wrapper = mount(AiModelGate);
    await flushPromises();

    await wrapper.find("button").trigger("click");

    expect(fakeLocalAiStore.markDownloadStarting).toHaveBeenCalled();
    expect(fakeLocalAiStore.downloadModel).toHaveBeenCalledWith("addr_a");
  });

  describe("pause/resume", () => {
    it("shows a Pause button while downloading and calls pauseDownload() on click", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 40, status: "downloading" } } };

      const wrapper = mount(AiModelGate);
      await flushPromises();

      const buttons = wrapper.findAll("button");
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.text()).toBe("Pause");

      await buttons[0]!.trigger("click");

      expect(fakeLocalAiStore.pauseDownload).toHaveBeenCalledWith("addr_a");
      expect(fakeLocalAiStore.resumeDownload).not.toHaveBeenCalled();
    });

    it("shows a Resume button and the paused label once isPaused is true, and calls resumeDownload() on click", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 40, status: "downloading" } } };
      fakeLocalAiStore.isPaused = true;

      const wrapper = mount(AiModelGate);
      await flushPromises();

      expect(wrapper.text()).toContain("Paused… 40%");
      const button = wrapper.find("button");
      expect(button.text()).toBe("Resume");

      await button.trigger("click");

      expect(fakeLocalAiStore.resumeDownload).toHaveBeenCalledWith("addr_a");
      expect(fakeLocalAiStore.pauseDownload).not.toHaveBeenCalled();
    });
  });

  // Regression: once the download itself finished, checksum verification
  // and loading the model into the runtime each silently ran with the
  // progress bar frozen at "Скачивание… 100%" — genuinely slow phases for
  // a GB-scale file, reported live as "скачалась модель - зависла на
  // 100%". Both phases now get their own distinct label, and neither
  // offers a Pause button (pausing means nothing once the download
  // transport itself is done).
  describe("verifying/loading phases", () => {
    it("shows incremental verification progress with its own label, and no Pause button", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 63, status: "verifying" } } };

      const wrapper = mount(AiModelGate);
      await flushPromises();

      expect(wrapper.text()).toContain("Verifying file… 63%");
      expect(wrapper.text()).not.toContain("Downloading… 63%");
      expect(wrapper.findAll("button")).toHaveLength(0); // no Pause — nothing to pause during local hashing
    });

    it("shows a distinct 'loading into memory' label with no percent, and no Pause button", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 100, status: "loading" } } };

      const wrapper = mount(AiModelGate);
      await flushPromises();

      expect(wrapper.text()).toContain("Loading model into memory…");
      expect(wrapper.text()).not.toContain("Downloading… 100%");
      expect(wrapper.findAll("button")).toHaveLength(0);
    });
  });
});
