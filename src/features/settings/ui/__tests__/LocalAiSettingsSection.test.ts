import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import LocalAiSettingsSection from "../LocalAiSettingsSection.vue";

// Regression: same as AiModelGate.test.ts — an `ensureClient()` failure only
// reached `initError`, never `downloadState.model.error`, and the "Скачать"/
// "Обновить" buttons in Settings → Local AI silently no-op'd on it.
const fakeLocalAiStore = reactive({
  supportReport: { isNative: true, capabilities: { inference: true } } as {
    isNative: boolean;
    capabilities: { inference: boolean };
  } | null,
  eligibilityReport: null as { verdict: "ok" | "tight" | "no" | "unknown" } | null,
  currentModel: null as { displayName: string; quant: string; sizeBytes: number } | null,
  downloadState: {
    model: { error: null as string | null, errorCode: null as string | null, progress: null as { percent: number; status?: string } | null },
  },
  modelReady: false,
  initError: null as string | null,
  checkSupportOnce: vi.fn(async () => {}),
  checkEligibility: vi.fn(async () => {}),
  refreshManifest: vi.fn(async () => {}),
  restoreModelIfPreviouslyDownloaded: vi.fn(async () => {}),
  partialDownload: null as { percent: number } | null,
  checkPartialDownload: vi.fn(async () => {}),
  markDownloadStarting: vi.fn(() => {}),
  downloadModel: vi.fn(async () => {}),
  switchModel: vi.fn(async () => {}),
  isPaused: false,
  pauseDownload: vi.fn(async () => {}),
  resumeDownload: vi.fn(async () => {}),
  deleteModel: vi.fn(async () => {}),
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

vi.mock("@/entities/tor", () => ({
  useTorStore: () => ({ mode: "off" }),
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
  "ai.delete": "Delete model",
  "ai.deleteConfirm": "Delete the downloaded model? You can download it again later.",
  "ai.discardDownload": "Discard download",
  "ai.discardDownloadConfirm": "Discard the downloaded data? You'll need to download the model from scratch.",
  "ai.deleting": "Deleting…",
  "common.cancel": "Cancel",
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
  fakeLocalAiStore.currentModel = null;
  fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: null } };
  fakeLocalAiStore.modelReady = false;
  fakeLocalAiStore.initError = null;
  fakeLocalAiStore.partialDownload = null;
  fakeLocalAiStore.isPaused = false;
  vi.clearAllMocks();
  // vi.clearAllMocks() clears call history but NOT a custom
  // mockImplementation() set by an earlier test — reset the mock this file's
  // resume test overrides with a side effect back to a safe no-op, or a
  // later "baseline" test can flakily inherit that override.
  fakeLocalAiStore.checkPartialDownload.mockImplementation(async () => {});
});

describe("LocalAiSettingsSection", () => {
  it("renders initError when ensureClient() failed and downloadState.error was never set", async () => {
    fakeLocalAiStore.initError = "Execute: Failed in beginTransaction Already in transaction";

    const wrapper = mount(LocalAiSettingsSection);
    await flushPromises();

    expect(wrapper.text()).toContain("Failed to prepare the AI engine: Execute: Failed in beginTransaction Already in transaction");
  });

  it("prefers downloadState.error over initError when both are set", async () => {
    fakeLocalAiStore.downloadState = { model: { error: "download-specific failure", errorCode: null, progress: null } };
    fakeLocalAiStore.initError = "stale init error from an earlier attempt";

    const wrapper = mount(LocalAiSettingsSection);
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

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      const buttons = wrapper.findAll("button");
      expect(buttons.some((b) => b.text() === "Pause")).toBe(false);
      expect(buttons.some((b) => /^(ai\.download|ai\.resumeDownload)/.test(b.text()))).toBe(true);
    });

    // Regression: a race between the automatic background restore check
    // and an explicit user tap (both call downloadModel()) could leave a
    // stale error in the store even after modelReady became true — showing
    // "download failed" right next to a fully populated, working model
    // card. The store defends against this too (see local-ai-store.test.ts),
    // but the UI suppresses the error outright once ready as a second line
    // of defense — modelReady is the fact that actually matters here.
    it("never shows the error text once the model is ready, even if downloadState.error is somehow still set", async () => {
      fakeLocalAiStore.modelReady = true;
      fakeLocalAiStore.downloadState = { model: { error: "stale error from a losing concurrent call", errorCode: "download_failed", progress: null } };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.text()).not.toContain("stale error from a losing concurrent call");
      expect(wrapper.text()).not.toContain("Couldn't download the model");
      expect(wrapper.text()).toContain("ai.ready"); // this file's dict has no mapping for it — the fake t() echoes the raw key back, matching its other baseline tests
    });

    it("maps errorCode 'checksum_mismatch' to the checksum-specific message", async () => {
      fakeLocalAiStore.downloadState = { model: { error: "sha256 mismatch", errorCode: "checksum_mismatch", progress: null } };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.text()).toContain("The downloaded file was corrupted. Try downloading the model again.");
    });

    it("maps errorCode 'insufficient_storage' to the storage-specific message", async () => {
      fakeLocalAiStore.downloadState = { model: { error: "insufficient storage", errorCode: "insufficient_storage", progress: null } };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.text()).toContain("Not enough storage space on this device to download the model.");
    });

    it("shows a resume-labeled button when partialDownload has real bytes after a failure", async () => {
      fakeLocalAiStore.downloadState = { model: { error: "network drop", errorCode: "download_failed", progress: null } };
      fakeLocalAiStore.partialDownload = { percent: 33 };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      const buttons = wrapper.findAll("button");
      expect(buttons.some((b) => b.text().includes("ai.resumeDownload"))).toBe(true);
    });
  });

  // Regression: chunked Range downloads can take a couple of seconds before
  // their first onProgress tick — tapping "Скачать" otherwise looked like it
  // did nothing for that whole window.
  it("marks the download as starting synchronously before awaiting downloadModel()", async () => {
    const wrapper = mount(LocalAiSettingsSection);
    await flushPromises();

    await wrapper.find("button").trigger("click"); // the download button is first when !modelReady

    expect(fakeLocalAiStore.markDownloadStarting).toHaveBeenCalled();
    expect(fakeLocalAiStore.downloadModel).toHaveBeenCalledWith("addr_a");
  });

  // Regression: an interrupted download resumes correctly at the transport
  // level (CapacitorRangeDownloadAdapter), but the button always read
  // "Скачать модель" regardless — indistinguishable from a fresh download,
  // reported as "resume doesn't work" when it actually did.
  it("checks for a partial download on mount and labels the button 'resume' when one exists", async () => {
    fakeLocalAiStore.checkPartialDownload.mockImplementation(async () => {
      fakeLocalAiStore.partialDownload = { percent: 17 };
    });

    const wrapper = mount(LocalAiSettingsSection);
    await flushPromises();

    expect(fakeLocalAiStore.checkPartialDownload).toHaveBeenCalledWith("addr_a");
    expect(wrapper.find("button").text()).toContain("ai.resumeDownload");
  });

  it("labels the button as a fresh download when there is no partial download", async () => {
    const wrapper = mount(LocalAiSettingsSection);
    await flushPromises();

    expect(wrapper.find("button").text()).toBe("ai.download");
  });

  describe("pause/resume", () => {
    it("shows a Pause button while downloading and calls pauseDownload() on click", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 40, status: "downloading" } } };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      const pauseButton = wrapper.findAll("button").find((b) => b.text() === "Pause");
      expect(pauseButton).toBeTruthy();

      await pauseButton!.trigger("click");

      expect(fakeLocalAiStore.pauseDownload).toHaveBeenCalledWith("addr_a");
    });

    it("shows a Resume button and the paused label once isPaused is true, and calls resumeDownload() on click", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 40, status: "downloading" } } };
      fakeLocalAiStore.isPaused = true;

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.text()).toContain("Paused… 40%");
      const resumeButton = wrapper.findAll("button").find((b) => b.text() === "Resume");
      expect(resumeButton).toBeTruthy();

      await resumeButton!.trigger("click");

      expect(fakeLocalAiStore.resumeDownload).toHaveBeenCalledWith("addr_a");
    });
  });

  // Regression: v1 shipped with no delete control at all (LocalAiClient had
  // no delete API) — this is the first coverage for it existing.
  describe("delete", () => {
    it("hides the delete button on a fresh device with nothing downloaded or in progress", async () => {
      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.findAll("button").find((b) => b.text() === "Delete model")).toBeUndefined();
    });

    // The confirm dialog is rendered via <Teleport to="body"> — outside the
    // component's own root element, so it's queried through document.body
    // directly rather than wrapper.find()/wrapper.text(), which only see
    // the wrapper's own DOM subtree.
    it("shows the delete button once the model is ready, opens a confirm dialog, and calls deleteModel() only after confirming", async () => {
      fakeLocalAiStore.modelReady = true;

      const wrapper = mount(LocalAiSettingsSection, { attachTo: document.body });
      await flushPromises();

      const deleteButton = wrapper.findAll("button").find((b) => b.text() === "Delete model");
      expect(deleteButton).toBeTruthy();
      await deleteButton!.trigger("click");

      expect(fakeLocalAiStore.deleteModel).not.toHaveBeenCalled(); // not yet — confirm dialog first
      expect(document.body.textContent).toContain("Delete the downloaded model?");

      const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
        (b) => b.textContent === "Delete model" && !wrapper.element.contains(b),
      );
      expect(confirmButton).toBeTruthy();
      confirmButton!.dispatchEvent(new Event("click"));
      await flushPromises();

      expect(fakeLocalAiStore.deleteModel).toHaveBeenCalledWith("addr_a");
      wrapper.unmount();
    });

    it("cancelling the confirm dialog never calls deleteModel()", async () => {
      fakeLocalAiStore.modelReady = true;

      const wrapper = mount(LocalAiSettingsSection, { attachTo: document.body });
      await flushPromises();
      await wrapper.findAll("button").find((b) => b.text() === "Delete model")!.trigger("click");

      const cancelButton = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Cancel");
      expect(cancelButton).toBeTruthy();
      cancelButton!.dispatchEvent(new Event("click"));
      await flushPromises();

      expect(fakeLocalAiStore.deleteModel).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Delete the downloaded model?");
      wrapper.unmount();
    });

    it("shows a 'discard download' (not 'delete model') label while a partial download exists and the model isn't ready", async () => {
      fakeLocalAiStore.partialDownload = { percent: 17 };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      // Never the "delete model" wording — nothing is actually fully
      // downloaded yet, so that phrasing would be inaccurate.
      expect(wrapper.findAll("button").find((b) => b.text() === "Delete model")).toBeUndefined();
      expect(wrapper.findAll("button").find((b) => b.text() === "Discard download")).toBeTruthy();
    });

    // Regression: the delete button rendered even while a transfer was
    // actively streaming in — showing "Удалить модель"/"delete the
    // downloaded model" made no sense (nothing is downloaded yet), and
    // having it sit right next to an advancing progress bar read as if
    // deleting and downloading could somehow happen at once.
    describe("hidden while actively downloading, shown while paused", () => {
      it("hides the delete button entirely while actively (un-paused) downloading", async () => {
        fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 40, status: "downloading" } } };
        fakeLocalAiStore.isPaused = false;

        const wrapper = mount(LocalAiSettingsSection);
        await flushPromises();

        expect(wrapper.findAll("button").find((b) => /^(Delete model|Discard download)$/.test(b.text()))).toBeUndefined();
      });

      it("shows the delete button (as 'Discard download') once paused mid-download", async () => {
        fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 40, status: "downloading" } } };
        fakeLocalAiStore.isPaused = true;

        const wrapper = mount(LocalAiSettingsSection);
        await flushPromises();

        expect(wrapper.findAll("button").find((b) => b.text() === "Discard download")).toBeTruthy();
      });
    });

    it("shows the delete button (as 'Discard download') after a download failure with the discard-specific confirm text", async () => {
      fakeLocalAiStore.downloadState = { model: { error: "network drop", errorCode: "download_failed", progress: null } };

      const wrapper = mount(LocalAiSettingsSection, { attachTo: document.body });
      await flushPromises();

      const deleteButton = wrapper.findAll("button").find((b) => b.text() === "Discard download");
      expect(deleteButton).toBeTruthy();
      await deleteButton!.trigger("click");

      expect(document.body.textContent).toContain("Discard the downloaded data? You'll need to download the model from scratch.");
      expect(document.body.textContent).not.toContain("Delete the downloaded model?");
      wrapper.unmount();
    });
  });

  // Regression: once the download itself finished, checksum verification
  // and loading the model into the runtime each silently ran with the
  // progress bar frozen at "Скачивание… 100%" — genuinely slow phases for
  // a GB-scale file, reported live as "скачалась модель - зависла на
  // 100%". Both phases now get their own distinct label (including in the
  // "Статус" row), and neither offers a Pause button.
  describe("verifying/loading phases", () => {
    it("shows incremental verification progress with its own label in both the status row and progress text, and no Pause button", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 63, status: "verifying" } } };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      const occurrences = wrapper.text().split("Verifying file… 63%").length - 1;
      expect(occurrences).toBe(2); // status row + progress text
      expect(wrapper.text()).not.toContain("Downloading… 63%");
      expect(wrapper.findAll("button").find((b) => b.text() === "Pause")).toBeUndefined();
    });

    it("shows a distinct 'loading into memory' label with no percent, and no Pause button", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 100, status: "loading" } } };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.text()).toContain("Loading model into memory…");
      expect(wrapper.text()).not.toContain("Downloading… 100%");
      expect(wrapper.findAll("button").find((b) => b.text() === "Pause")).toBeUndefined();
    });

    it("hides the delete/discard button during verifying and loading, same as an active download", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 100, status: "loading" } } };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.findAll("button").find((b) => /^(Delete model|Discard download)$/.test(b.text()))).toBeUndefined();
    });
  });
});
