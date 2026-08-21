import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import LocalAiSettingsSection from "../LocalAiSettingsSection.vue";

// Regression: same as AiModelGate.test.ts — an `ensureClient()` failure only
// reached `initError`, never `downloadState.model.error`, and the "Скачать"/
// "Обновить" buttons in Settings → Local AI silently no-op'd on it.
type FakeModel = { id: string; displayName: string; quant: string; sizeBytes: number; recommended?: boolean };
type DiskState = { percent: number } | null;

const QWEN_4B: FakeModel = { id: "qwen-4b", displayName: "Qwen 4B", quant: "Q4_K_M", sizeBytes: 2_500_000_000, recommended: true };

const fakeLocalAiStore = reactive({
  supportReport: { isNative: true, capabilities: { inference: true } } as {
    isNative: boolean;
    capabilities: { inference: boolean };
  } | null,
  eligibilityReport: null as { verdict: "ok" | "tight" | "no" | "unknown" } | null,
  // Multi-model plan §9 — single-fixture manifest by default (most tests
  // here don't care about model identity, only download/progress/error/
  // delete UI); `availableModels`/`currentModel` mirror the real store's
  // resolved-selection shape once a manifest has been fetched.
  availableModels: [QWEN_4B] as FakeModel[],
  selectedModelId: null as string | null,
  currentModel: QWEN_4B as FakeModel | null,
  loadedModelId: null as string | null,
  activeModelUpdateAvailable: false,
  // Multi-model UI rework (2026-08-21) — per-model disk residency, drives
  // Скачать/Докачать/Переключиться and per-row delete visibility.
  modelDiskState: {} as Record<string, DiskState>,
  downloadState: {
    model: { error: null as string | null, errorCode: null as string | null, progress: null as { percent: number; status?: string } | null },
  },
  modelReady: false,
  initError: null as string | null,
  checkSupportOnce: vi.fn(async () => {}),
  checkEligibility: vi.fn(async () => {}),
  modelEligibility: vi.fn(async (_address: string, _modelId: string): Promise<{ verdict: "ok" | "tight" | "no" | "unknown" }> => ({
    verdict: "ok",
  })),
  checkModelDiskState: vi.fn(async (_address: string, modelId: string): Promise<DiskState> => fakeLocalAiStore.modelDiskState[modelId] ?? null),
  selectModel: vi.fn(async (_address: string, _modelId: string) => {}),
  refreshManifest: vi.fn(async () => {}),
  restoreModelIfPreviouslyDownloaded: vi.fn(async () => {}),
  partialDownload: null as { percent: number } | null,
  checkPartialDownload: vi.fn(async () => {}),
  markDownloadStarting: vi.fn((_modelId?: string) => {}),
  downloadModel: vi.fn(async () => {}),
  switchModel: vi.fn(async () => {}),
  isPaused: false,
  pauseDownload: vi.fn(async () => {}),
  resumeDownload: vi.fn(async () => {}),
  deleteModel: vi.fn(async (_address: string, _modelId?: string) => {}),
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

/** Scopes to one model's row (`.rounded-xl` card) by its displayName text —
 *  `find("button")` alone can't disambiguate rows that render the same
 *  button text (e.g. two not-yet-downloaded models both showing
 *  "ai.download"), and the section now also has an icon-only refresh
 *  button that has no text of its own to collide with anyway. */
function findRow(wrapper: ReturnType<typeof mount>, displayName: string) {
  return wrapper.findAll(".rounded-xl").find((el) => el.text().includes(displayName));
}
function rowActionButton(wrapper: ReturnType<typeof mount>, displayName: string) {
  // The row's action button is the last labeled (non-icon-only) button in
  // its card — distinguishes it from the row's own kebab ("⋮") menu button,
  // which also lives inside the same `.rounded-xl` card but has no text.
  return findRow(wrapper, displayName)
    ?.findAll("button")
    .filter((b) => b.text().length > 0)
    .at(-1);
}

beforeEach(() => {
  fakeLocalAiStore.supportReport = { isNative: true, capabilities: { inference: true } };
  fakeLocalAiStore.eligibilityReport = null;
  fakeLocalAiStore.availableModels = [QWEN_4B];
  fakeLocalAiStore.selectedModelId = null;
  fakeLocalAiStore.currentModel = QWEN_4B;
  fakeLocalAiStore.loadedModelId = null;
  fakeLocalAiStore.activeModelUpdateAvailable = false;
  fakeLocalAiStore.modelDiskState = {};
  fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: null } };
  fakeLocalAiStore.modelReady = false;
  fakeLocalAiStore.initError = null;
  fakeLocalAiStore.partialDownload = null;
  fakeLocalAiStore.isPaused = false;
  vi.clearAllMocks();
  // vi.clearAllMocks() clears call history but NOT a custom
  // mockImplementation() set by an earlier test — reset every mock a later
  // test overrides with a custom implementation back to a safe default, or
  // a later "baseline" test can flakily inherit that override.
  fakeLocalAiStore.checkPartialDownload.mockImplementation(async () => {});
  fakeLocalAiStore.modelEligibility.mockImplementation(async () => ({ verdict: "ok" as const }));
  fakeLocalAiStore.checkModelDiskState.mockImplementation(async (_address, modelId) => fakeLocalAiStore.modelDiskState[modelId] ?? null);
  fakeLocalAiStore.selectModel.mockImplementation(async () => {});
  fakeLocalAiStore.downloadModel.mockImplementation(async () => {});
  fakeLocalAiStore.deleteModel.mockImplementation(async () => {});
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

  // Automatic check-for-updates on mount (multi-model UI rework, 2026-08-21)
  // — no manual "Проверить обновления" button needed anymore.
  it("automatically refreshes the manifest on mount, without any button click", async () => {
    mount(LocalAiSettingsSection);
    await flushPromises();

    expect(fakeLocalAiStore.refreshManifest).toHaveBeenCalledWith("addr_a");
  });

  it("the manual refresh icon re-runs refreshManifest()/eligibility/disk-state checks", async () => {
    const wrapper = mount(LocalAiSettingsSection);
    await flushPromises();
    vi.clearAllMocks();
    fakeLocalAiStore.refreshManifest.mockResolvedValue(undefined);

    const refreshButton = wrapper.find('[aria-label="ai.checkUpdates"]');
    expect(refreshButton.exists()).toBe(true);
    await refreshButton.trigger("click");

    expect(fakeLocalAiStore.refreshManifest).toHaveBeenCalledWith("addr_a");
    expect(fakeLocalAiStore.modelEligibility).toHaveBeenCalled();
    expect(fakeLocalAiStore.checkModelDiskState).toHaveBeenCalled();
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
      fakeLocalAiStore.loadedModelId = fakeLocalAiStore.currentModel?.id ?? QWEN_4B.id;
      fakeLocalAiStore.downloadState = { model: { error: "stale error from a losing concurrent call", errorCode: "download_failed", progress: null } };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.text()).not.toContain("stale error from a losing concurrent call");
      expect(wrapper.text()).not.toContain("Couldn't download the model");
      expect(wrapper.text()).toContain("ai.active"); // this file's dict has no mapping for it — the fake t() echoes the raw key back, matching its other baseline tests
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

    it("shows a resume-labeled button when the model's disk state has real partial bytes after a failure", async () => {
      fakeLocalAiStore.downloadState = { model: { error: "network drop", errorCode: "download_failed", progress: null } };
      fakeLocalAiStore.modelDiskState = { [QWEN_4B.id]: { percent: 33 } };

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

    await rowActionButton(wrapper, "Qwen 4B")!.trigger("click");

    expect(fakeLocalAiStore.markDownloadStarting).toHaveBeenCalledWith(QWEN_4B.id);
    expect(fakeLocalAiStore.downloadModel).toHaveBeenCalledWith("addr_a");
  });

  it("does not seed a fake 'starting' placeholder when switching to an already-resident model", async () => {
    fakeLocalAiStore.modelDiskState = { [QWEN_4B.id]: { percent: 100 } };

    const wrapper = mount(LocalAiSettingsSection);
    await flushPromises();
    await rowActionButton(wrapper, "Qwen 4B")!.trigger("click");

    expect(fakeLocalAiStore.markDownloadStarting).not.toHaveBeenCalled();
    expect(fakeLocalAiStore.downloadModel).toHaveBeenCalledWith("addr_a");
  });

  // Regression: an interrupted download resumes correctly at the transport
  // level (CapacitorRangeDownloadAdapter), but the button always read
  // "Скачать модель" regardless — indistinguishable from a fresh download,
  // reported as "resume doesn't work" when it actually did.
  it("checks per-model disk state on mount and labels the button 'resume' when a real partial file exists", async () => {
    fakeLocalAiStore.checkModelDiskState.mockImplementation(async (_address, modelId) => {
      fakeLocalAiStore.modelDiskState[modelId] = { percent: 17 };
      return fakeLocalAiStore.modelDiskState[modelId];
    });

    const wrapper = mount(LocalAiSettingsSection);
    await flushPromises();

    expect(fakeLocalAiStore.checkModelDiskState).toHaveBeenCalledWith("addr_a", QWEN_4B.id);
    expect(rowActionButton(wrapper, "Qwen 4B")!.text()).toContain("ai.resumeDownload");
  });

  it("labels the button as a fresh download when there is nothing on disk", async () => {
    const wrapper = mount(LocalAiSettingsSection);
    await flushPromises();

    expect(rowActionButton(wrapper, "Qwen 4B")!.text()).toBe("ai.download");
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
  // no delete API) — now per-row, tucked into a small overflow ("⋮") menu
  // (multi-model UI rework, 2026-08-21).
  describe("delete", () => {
    it("hides the row's overflow menu on a fresh device with nothing downloaded", async () => {
      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(findRow(wrapper, "Qwen 4B")!.findAll("button")).toHaveLength(1); // action button only, no kebab
    });

    // The confirm dialog is rendered via <Teleport to="body"> — outside the
    // component's own root element, so it's queried through document.body
    // directly rather than wrapper.find()/wrapper.text(), which only see
    // the wrapper's own DOM subtree.
    it("opens the overflow menu, then a confirm dialog, and calls deleteModel(address, modelId) only after confirming", async () => {
      fakeLocalAiStore.modelReady = true;
      fakeLocalAiStore.loadedModelId = QWEN_4B.id;
      fakeLocalAiStore.modelDiskState = { [QWEN_4B.id]: { percent: 100 } };

      const wrapper = mount(LocalAiSettingsSection, { attachTo: document.body });
      await flushPromises();

      const kebabButton = findRow(wrapper, "Qwen 4B")!.findAll("button")[0]!; // kebab is the first (icon-only) button in the row
      await kebabButton.trigger("click");
      const deleteMenuItem = wrapper.findAll("button").find((b) => b.text() === "Delete model");
      expect(deleteMenuItem).toBeTruthy();
      await deleteMenuItem!.trigger("click");

      expect(fakeLocalAiStore.deleteModel).not.toHaveBeenCalled(); // not yet — confirm dialog first
      expect(document.body.textContent).toContain("Delete the downloaded model?");

      const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
        (b) => b.textContent === "Delete model" && !wrapper.element.contains(b),
      );
      expect(confirmButton).toBeTruthy();
      confirmButton!.dispatchEvent(new Event("click"));
      await flushPromises();

      expect(fakeLocalAiStore.deleteModel).toHaveBeenCalledWith("addr_a", QWEN_4B.id);
      wrapper.unmount();
    });

    it("cancelling the confirm dialog never calls deleteModel()", async () => {
      fakeLocalAiStore.modelReady = true;
      fakeLocalAiStore.loadedModelId = QWEN_4B.id;
      fakeLocalAiStore.modelDiskState = { [QWEN_4B.id]: { percent: 100 } };

      const wrapper = mount(LocalAiSettingsSection, { attachTo: document.body });
      await flushPromises();
      await findRow(wrapper, "Qwen 4B")!.findAll("button")[0]!.trigger("click"); // open kebab
      await wrapper.findAll("button").find((b) => b.text() === "Delete model")!.trigger("click"); // request delete

      const cancelButton = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Cancel");
      expect(cancelButton).toBeTruthy();
      cancelButton!.dispatchEvent(new Event("click"));
      await flushPromises();

      expect(fakeLocalAiStore.deleteModel).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Delete the downloaded model?");
      wrapper.unmount();
    });

    it("shows a 'discard download' (not 'delete model') menu label for a real partial download that isn't complete", async () => {
      fakeLocalAiStore.modelDiskState = { [QWEN_4B.id]: { percent: 17 } };

      const wrapper = mount(LocalAiSettingsSection, { attachTo: document.body });
      await flushPromises();
      await findRow(wrapper, "Qwen 4B")!.findAll("button")[0]!.trigger("click");

      // Never the "delete model" wording — nothing is actually fully
      // downloaded yet, so that phrasing would be inaccurate.
      expect(wrapper.findAll("button").find((b) => b.text() === "Delete model")).toBeUndefined();
      expect(wrapper.findAll("button").find((b) => b.text() === "Discard download")).toBeTruthy();
      wrapper.unmount();
    });

    // Regression: the delete affordance rendered even while a transfer was
    // actively streaming in — showing "Удалить модель"/"delete the
    // downloaded model" made no sense (nothing is downloaded yet), and
    // having it sit right next to an advancing progress bar read as if
    // deleting and downloading could somehow happen at once.
    describe("hidden while actively downloading, shown while paused", () => {
      it("hides the row's overflow menu entirely while actively (un-paused) downloading", async () => {
        fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 40, status: "downloading" } } };
        fakeLocalAiStore.isPaused = false;
        fakeLocalAiStore.modelDiskState = { [QWEN_4B.id]: { percent: 40 } };

        const wrapper = mount(LocalAiSettingsSection);
        await flushPromises();

        // The row's action area is hidden entirely while downloading (see
        // isRowDownloading), so there's no button at all in the row's card.
        expect(findRow(wrapper, "Qwen 4B")!.findAll("button")).toHaveLength(0);
      });

      it("shows the overflow menu (as 'Discard download') once paused mid-download", async () => {
        fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 40, status: "downloading" } } };
        fakeLocalAiStore.isPaused = true;
        fakeLocalAiStore.modelDiskState = { [QWEN_4B.id]: { percent: 40 } };

        const wrapper = mount(LocalAiSettingsSection);
        await flushPromises();
        await findRow(wrapper, "Qwen 4B")!.find("button").trigger("click");

        expect(wrapper.findAll("button").find((b) => b.text() === "Discard download")).toBeTruthy();
      });
    });

    it("shows the overflow menu (as 'Discard download') after a download failure with the discard-specific confirm text", async () => {
      fakeLocalAiStore.downloadState = { model: { error: "network drop", errorCode: "download_failed", progress: null } };
      fakeLocalAiStore.modelDiskState = { [QWEN_4B.id]: { percent: 40 } };

      const wrapper = mount(LocalAiSettingsSection, { attachTo: document.body });
      await flushPromises();
      await findRow(wrapper, "Qwen 4B")!.findAll("button")[0]!.trigger("click");
      const menuItem = wrapper.findAll("button").find((b) => b.text() === "Discard download");
      expect(menuItem).toBeTruthy();
      await menuItem!.trigger("click");

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
  // row's own status text), and neither offers a Pause button.
  describe("verifying/loading phases", () => {
    it("shows incremental verification progress with its own label in both the row status and progress text, and no Pause button", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 63, status: "verifying" } } };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      const occurrences = wrapper.text().split("Verifying file… 63%").length - 1;
      expect(occurrences).toBe(2); // row status + progress text
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

    it("hides the row's action area (including the overflow menu) during verifying and loading, same as an active download", async () => {
      fakeLocalAiStore.downloadState = { model: { error: null, errorCode: null, progress: { percent: 100, status: "loading" } } };
      fakeLocalAiStore.modelDiskState = { [QWEN_4B.id]: { percent: 100 } };

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(findRow(wrapper, "Qwen 4B")!.findAll("button")).toHaveLength(0);
    });
  });

  // Multi-model UI rework (2026-08-21) — the model-picker list.
  describe("multi-model list", () => {
    const SMALL_MODEL: FakeModel = { id: "small-model", displayName: "Small Model", quant: "Q4_K_M", sizeBytes: 900_000_000 };

    it("renders one row per model in availableModels", async () => {
      fakeLocalAiStore.availableModels = [QWEN_4B, SMALL_MODEL];

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.text()).toContain("Qwen 4B");
      expect(wrapper.text()).toContain("Small Model");
    });

    it("marks the recommended model", async () => {
      fakeLocalAiStore.availableModels = [QWEN_4B, SMALL_MODEL];

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.text()).toContain("ai.recommended"); // unmapped in this file's dict — echoed raw
    });

    it("a model whose eligibility check resolves 'no' has its action button disabled and unclickable", async () => {
      fakeLocalAiStore.availableModels = [QWEN_4B, SMALL_MODEL];
      fakeLocalAiStore.modelEligibility.mockImplementation(async (_address, modelId) => ({
        verdict: modelId === "qwen-4b" ? ("no" as const) : ("ok" as const),
      }));

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      const qwenButton = rowActionButton(wrapper, "Qwen 4B");
      expect(qwenButton?.exists()).toBe(true);
      expect(qwenButton?.attributes("disabled")).toBeDefined();

      await qwenButton!.trigger("click");
      expect(fakeLocalAiStore.downloadModel).not.toHaveBeenCalled();
    });

    it("clicking 'download' on a not-yet-selected model calls selectModel() before downloadModel()", async () => {
      fakeLocalAiStore.availableModels = [QWEN_4B, SMALL_MODEL];
      fakeLocalAiStore.selectedModelId = "qwen-4b";
      const callOrder: string[] = [];
      fakeLocalAiStore.selectModel.mockImplementation(async () => {
        callOrder.push("selectModel");
      });
      fakeLocalAiStore.downloadModel.mockImplementation(async () => {
        callOrder.push("downloadModel");
      });

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      const smallButton = rowActionButton(wrapper, "Small Model");
      expect(smallButton?.exists()).toBe(true);
      await smallButton!.trigger("click");

      expect(fakeLocalAiStore.selectModel).toHaveBeenCalledWith("addr_a", "small-model");
      expect(callOrder).toEqual(["selectModel", "downloadModel"]);
    });

    it("does not call selectModel() again when the clicked model is already the selection", async () => {
      fakeLocalAiStore.availableModels = [QWEN_4B, SMALL_MODEL];
      fakeLocalAiStore.selectedModelId = "small-model";

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      const smallButton = rowActionButton(wrapper, "Small Model");
      await smallButton!.trigger("click");

      expect(fakeLocalAiStore.selectModel).not.toHaveBeenCalled();
      expect(fakeLocalAiStore.downloadModel).toHaveBeenCalledWith("addr_a");
    });

    it("the active model's row shows a disabled 'Active' state instead of a download button", async () => {
      fakeLocalAiStore.availableModels = [QWEN_4B, SMALL_MODEL];
      fakeLocalAiStore.modelReady = true;
      fakeLocalAiStore.loadedModelId = QWEN_4B.id;
      fakeLocalAiStore.currentModel = QWEN_4B;

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(wrapper.text()).toContain("ai.active");
      // The other (non-active) model still shows its own download action.
      const smallButton = rowActionButton(wrapper, "Small Model");
      expect(smallButton?.text()).toBe("ai.download");
    });

    it("shows 'switch' wording for a different, already-resident model instead of 'download'", async () => {
      fakeLocalAiStore.availableModels = [QWEN_4B, SMALL_MODEL];
      fakeLocalAiStore.modelReady = true;
      fakeLocalAiStore.loadedModelId = QWEN_4B.id;
      fakeLocalAiStore.currentModel = QWEN_4B;
      fakeLocalAiStore.modelDiskState = { [SMALL_MODEL.id]: { percent: 100 } }; // retainInactiveModels — resident but not active

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(rowActionButton(wrapper, "Small Model")?.text()).toBe("ai.switchTo");
    });

    it("shows 'download' (not 'switch') for a different model that genuinely isn't on disk", async () => {
      fakeLocalAiStore.availableModels = [QWEN_4B, SMALL_MODEL];
      fakeLocalAiStore.modelReady = true;
      fakeLocalAiStore.loadedModelId = QWEN_4B.id;
      fakeLocalAiStore.currentModel = QWEN_4B;

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      expect(rowActionButton(wrapper, "Small Model")?.text()).toBe("ai.download");
    });

    it("shows 'Обновить' instead of 'Активна' on the active row when an update is available, and calls switchModel()", async () => {
      fakeLocalAiStore.modelReady = true;
      fakeLocalAiStore.loadedModelId = QWEN_4B.id;
      fakeLocalAiStore.activeModelUpdateAvailable = true;

      const wrapper = mount(LocalAiSettingsSection);
      await flushPromises();

      const button = rowActionButton(wrapper, "Qwen 4B");
      expect(button?.text()).toBe("ai.update");
      await button!.trigger("click");

      expect(fakeLocalAiStore.switchModel).toHaveBeenCalledWith("addr_a");
    });
  });
});
