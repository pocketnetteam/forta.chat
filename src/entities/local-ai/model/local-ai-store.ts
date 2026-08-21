import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { LocalAiClient, LocalAiConfig, ManifestDiff, ModelArtifact, PartialDownloadProgress, PlatformSupportPort } from "local-ai";

import { createLocalAiConfig, createPlatformSupportPort } from "../lib/create-client";
import { createEmptyDownloadState, type EligibilityReport, type SupportReport } from "./types";

/** Device-wide (not per-account — the model file is shared/content-addressed
 *  across accounts, plan §4.2) marker of WHICH model `ensureModelReady()`
 *  last succeeded for on this device — the model's `id`, not a bare boolean
 *  (multi-model plan §8 p.3: with more than one model on offer, "something
 *  was downloaded before" isn't enough, `restoreModelIfPreviouslyDownloaded`
 *  needs to know *which* one to avoid silently kicking off a fresh
 *  multi-GB download of whatever's merely selected-but-not-yet-applied).
 *  `downloadState.model.ready` itself is in-memory only and resets to
 *  `false` on every fresh app launch/Pinia reset, even though the file is
 *  still on disk — without this marker, `AiModelGate`/Settings would show
 *  the "Скачать" gate again on every app restart, forcing a redundant (if
 *  fast, no-op) click before an already-downloaded model can be used.
 *  Read/write are best-effort — a `localStorage` failure just means the
 *  one-time restore silently doesn't happen and the user sees the ordinary
 *  download gate instead, same as before this existed. */
export const MODEL_DOWNLOADED_MARKER_KEY = "local_ai_model_downloaded";

function readModelDownloadedMarker(): string | null {
  try {
    return window.localStorage.getItem(MODEL_DOWNLOADED_MARKER_KEY);
  } catch {
    return null;
  }
}

function writeModelDownloadedMarker(modelId: string): void {
  try {
    window.localStorage.setItem(MODEL_DOWNLOADED_MARKER_KEY, modelId);
  } catch {
    // best-effort — see MODEL_DOWNLOADED_MARKER_KEY doc comment
  }
}

/** Counterpart to {@link writeModelDownloadedMarker} — clears the marker
 *  after `deleteModel()` so a later app restart doesn't try to silently
 *  restore a model that was just deliberately deleted. */
function clearModelDownloadedMarker(): void {
  try {
    window.localStorage.removeItem(MODEL_DOWNLOADED_MARKER_KEY);
  } catch {
    // best-effort — see MODEL_DOWNLOADED_MARKER_KEY doc comment
  }
}

/**
 * Owner of the `local-ai` runtime (plan §4, roadmap Phase 2). Two questions
 * both Settings → Local AI and an open AI-chat need answered from the SAME
 * state: "is the model ready right now" and "is a download in progress and
 * at what percent" — one Pinia store, no duplicated `onProgress` polling.
 *
 * Does NOT own chat/message data — that's `entities/ai-chat` (Dexie, Mode B
 * source of truth). This store only owns the `LocalAiClient` instance and
 * its lifecycle/eligibility/download state.
 */
export const useLocalAiStore = defineStore("local-ai", () => {
  const client = shallowRef<LocalAiClient | null>(null);
  const currentAddress = ref<string | null>(null);
  const supportReport = ref<SupportReport | null>(null);
  const eligibilityReport = ref<EligibilityReport | null>(null);
  const downloadState = ref({
    model: createEmptyDownloadState(),
    embedding: createEmptyDownloadState(),
  });
  /** Blocks `sendMessage` across EVERY AI chat, not just the active one —
   *  `local-ai` allows exactly one generation at a time (`RuntimeBusyError`,
   *  plan §7.3). Toggled by `entities/ai-chat`'s `sendMessage`/cancel. */
  const isGenerating = ref(false);
  const initError = ref<string | null>(null);
  /** Every `status: 'active'` model in the current manifest (multi-model
   *  plan §6/§9) — Settings → Local AI's model picker list. Populated by
   *  `refreshManifest()` and kept in sync via the `manifest:updated` event;
   *  empty until the manifest has been fetched at least once. */
  const availableModels = ref<ModelArtifact[]>([]);
  /** Mirrors `LocalAiClient.getSelectedModelId()` — the user's persisted
   *  model choice (`null` = none made yet, `currentModel` below falls back
   *  to `recommended`/first-active the same way the client itself does).
   *  Kept in sync by `refreshManifest()`/`ensureClient()`/`selectModel()` —
   *  no separate localStorage layer: `LocalAiClient`'s own per-account
   *  `kv_store` (already namespaced by `databaseName: local_ai_<address>`,
   *  `create-client.ts`) is the actual durable store, this ref just mirrors
   *  it for reactive UI reads. */
  const selectedModelId = ref<string | null>(null);
  /** The resolved "current" model for display (Settings → Local AI's model
   *  info card) — the selected model if `selectedModelId` names one still
   *  active in `availableModels`, else the manifest's `recommended: true`
   *  model, else the first active one. Mirrors
   *  `LocalAiClient`'s own `resolveSelectedModel()` fallback (multi-model
   *  plan §6 п.1/п.3) so the UI never shows "—" while the library itself
   *  would happily resolve a default. */
  const currentModel = computed<ModelArtifact | null>(() => {
    if (availableModels.value.length === 0) return null;
    const bySelection = selectedModelId.value
      ? availableModels.value.find((m) => m.id === selectedModelId.value)
      : undefined;
    if (bySelection) return bySelection;
    return availableModels.value.find((m) => m.recommended === true) ?? availableModels.value[0] ?? null;
  });
  /** Per-modelId cache for {@link modelEligibility} — a model-picker list
   *  renders one eligibility badge per row; without caching, re-rendering
   *  the list would re-run `checkDeviceEligibility()` (a device-info read)
   *  once per row on every reactive update. Cleared on `manifest:updated`
   *  (thresholds may have changed) and `releaseRuntime()` (account switch). */
  const modelEligibilityCache = ref<Record<string, EligibilityReport>>({});
  /** Bytes already on disk for an interrupted-and-not-yet-resumed model
   *  download, read without starting anything (roadmap: "докачать модель
   *  (X%)" instead of "Скачать модель" when there's real work to resume —
   *  see `checkPartialDownload()`). `null` = nothing to report, either a
   *  fresh device or the check hasn't run yet this mount. */
  const partialDownload = ref<PartialDownloadProgress | null>(null);
  /** UI-only "is the model download currently paused" flag — `local-ai`'s
   *  own `pauseModelDownload()` doesn't surface this through
   *  `download:progress` at all (the transport's `pause()` deliberately
   *  fires neither `onProgress` nor any other event while paused, so there
   *  is nothing for `download:progress` to relay), so the store tracks it
   *  independently. Toggled by `pauseDownload()`/`resumeDownload()`;
   *  cleared by any real progress tick or a terminal
   *  `download:completed`/`download:failed`, so a stale "paused" label
   *  can't survive past whatever actually happens to the transfer next. */
  const isPaused = ref(false);

  const modelReady = computed(() => downloadState.value.model.ready);

  let unsubscribers: Array<() => void> = [];
  let pendingCreation: { address: string; promise: Promise<LocalAiClient> } | null = null;
  /** Bumped by every `releaseRuntime()` and every new `ensureClient()`
   *  creation. Lets a creation that's still in flight when a later call
   *  supersedes it (a `releaseRuntime()`, or an `ensureClient()` for a
   *  DIFFERENT address) detect that on completion and discard its result
   *  instead of silently resurrecting a torn-down session or adopting the
   *  wrong account's client (plan §4.2 per-account isolation). */
  let creationGeneration = 0;

  function clearEventSubscriptions(): void {
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
  }

  /** Single place every download-failure path (the `download:failed` event,
   *  and `downloadModel()`/`switchModel()`'s own catch blocks for a failure
   *  that happens before any download even starts, e.g. an eligibility
   *  check) funnels through. Three things every one of those needs:
   *  1) `errorCode` alongside the raw message, so the UI can show a
   *     translated, human-readable string instead of exception text like
   *     "download of model__x__v1.gguf failed after 5 attempts: ..." — a
   *     real network blip mid-download surfaced exactly that, with no
   *     clear next action (docs/decisions.md).
   *  2) Clearing `progress` to `null` — otherwise `isDownloading` (`progress
   *     !== null`) stays true forever after a failure, hiding the
   *     Скачать/Докачать button behind a stale, non-functional-looking
   *     progress bar with no way for the user to actually retry.
   *  3) Re-reading how many bytes are actually still on disk, so the button
   *     that reappears reads "Докачать модель (X%)" — accurate for a
   *     resume-capable transport, since bytes already downloaded before a
   *     transient failure (e.g. the connection dropping) are still there —
   *     rather than a bare "Скачать модель" that reads like starting over. */
  function applyDownloadFailure(kind: "model" | "embedding", error: Error): void {
    downloadState.value[kind].error = error.message;
    downloadState.value[kind].errorCode = (error as Partial<{ code: string }>).code ?? null;
    downloadState.value[kind].progress = null;
    if (kind !== "model") return;
    isPaused.value = false;
    client.value
      ?.getDownloadProgress("model")
      .then((p) => {
        partialDownload.value = p;
      })
      .catch(() => {});
  }

  function subscribeToEvents(c: LocalAiClient): void {
    clearEventSubscriptions();
    unsubscribers.push(
      c.on("download:progress", (progress) => {
        downloadState.value[progress.kind].progress = progress;
        if (progress.status === "completed") {
          downloadState.value[progress.kind].error = null;
          downloadState.value[progress.kind].errorCode = null;
        }
        if (progress.kind === "model") isPaused.value = false; // a real tick landed — definitely not paused anymore
      }),
      c.on("download:completed", ({ kind }) => {
        downloadState.value[kind].ready = true;
        downloadState.value[kind].progress = null;
        downloadState.value[kind].error = null;
        downloadState.value[kind].errorCode = null;
        if (kind === "model") {
          partialDownload.value = null;
          isPaused.value = false;
        }
      }),
      c.on("download:failed", ({ kind, error }) => applyDownloadFailure(kind, error)),
      // The actual model that got loaded — covers downloadModel()/
      // switchModel() alike, and ensureModelReady()'s own internal
      // convergence when a different model was already live (multi-model
      // plan §6 п.4) — whichever path led here, this is the id that's
      // really on disk and in the runtime right now.
      c.on("runtime:model-loaded", ({ modelId }) => {
        writeModelDownloadedMarker(modelId);
      }),
      c.on("manifest:updated", (diff) => {
        // Cached manifest changed — eligibility may now read differently
        // against the new/changed artifacts, force a re-check next time
        // it's asked.
        eligibilityReport.value = null;
        modelEligibilityCache.value = {};
        applyManifestDiff(c, diff);
      }),
      c.on("manifest:invalid", ({ error }) => {
        initError.value = error.message;
      }),
      c.on("device:eligibility-warning", (report) => {
        eligibilityReport.value = report;
      }),
      c.on("model:selected", ({ modelId }) => {
        selectedModelId.value = modelId;
      }),
    );
  }

  /** Shared by the `manifest:updated` handler and `refreshManifest()` (which
   *  needs this even on the very first fetch — `manifest:updated` itself
   *  only fires on a genuine change, TZ §5.3's `If-None-Match`/304 path).
   *  `diff.models` already carries every model in the fresh manifest as
   *  `.to` (plus any removed-since-installed id with `to: undefined`) — no
   *  separate manifest read needed, `LocalAiClient` has no public getter
   *  for the raw manifest by design (hexagonal boundary). */
  function applyManifestDiff(c: LocalAiClient, diff: ManifestDiff): void {
    availableModels.value = diff.models
      .map((m) => m.to)
      .filter((m): m is ModelArtifact => m != null && m.status === "active");
    selectedModelId.value = c.getSelectedModelId();
  }

  /** Environment-only check — no network, safe before `ensureClient()`.
   *  Cached for the session; call again after a native-plugin-affecting
   *  change is not expected mid-session.
   *  @param platformSupportOverride Test seam — pass a
   *    `local-ai/adapters/node-testing` `FakePlatformSupportAdapter` instead
   *    of the real Capacitor one (roadmap 2.2). Production callers omit it. */
  async function checkSupportOnce(platformSupportOverride?: PlatformSupportPort): Promise<SupportReport> {
    if (supportReport.value) return supportReport.value;
    const { LocalAiClient: Client } = await import("local-ai");
    const platformSupport = platformSupportOverride ?? (await createPlatformSupportPort());
    const report = await Client.checkSupport({ platformSupport });
    supportReport.value = report;
    return report;
  }

  /** Lazy, once-per-session client creation (plan §4.1 — never eager at app
   *  boot). Concurrent callers share the same in-flight creation.
   *  @param configOverride Test seam — pass a config built with
   *    `local-ai/adapters/node-testing` fakes instead of the real Capacitor
   *    adapters (roadmap 2.2). Production callers omit it. */
  async function ensureClient(address: string, configOverride?: LocalAiConfig): Promise<LocalAiClient> {
    if (client.value && currentAddress.value === address) return client.value;

    // Concurrent callers for the SAME address share the same in-flight
    // creation. A concurrent call for a DIFFERENT address gets its own —
    // never returns another account's (in-flight or otherwise) client.
    if (pendingCreation?.address === address) return pendingCreation.promise;

    // Address changed (account switch) while a client is live — release the
    // old one first so its per-account SQLite connection is closed before a
    // new one opens (plan §4.2).
    if (client.value && currentAddress.value !== address) {
      await releaseRuntime();
    }

    const myGeneration = ++creationGeneration;
    const promise: Promise<LocalAiClient> = (async () => {
      try {
        initError.value = null;
        const { LocalAiClient: Client } = await import("local-ai");
        const config = configOverride ?? (await createLocalAiConfig(address));
        const created = await Client.create(config);
        if (myGeneration !== creationGeneration) {
          // Superseded by a releaseRuntime()/another ensureClient() call
          // while create() was in flight — don't resurrect a torn-down
          // session or adopt the wrong account's client; release what we
          // just created and surface the supersession to this caller only.
          await created.releaseRuntime({ closeDatabase: true }).catch(() => {});
          throw new Error("[LocalAi] ensureClient superseded by a concurrent releaseRuntime/ensureClient call");
        }
        subscribeToEvents(created);
        client.value = created;
        currentAddress.value = address;
        return created;
      } catch (e) {
        initError.value = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        if (pendingCreation?.address === address) pendingCreation = null;
      }
    })();

    pendingCreation = { address, promise };
    return promise;
  }

  async function refreshManifest(address: string): Promise<void> {
    const c = await ensureClient(address);
    const diff = await c.refreshManifest();
    // Reflects the diff's own return value directly — `manifest:updated`
    // only fires on a genuine change (TZ §5.3's `If-None-Match`/304 path),
    // but `availableModels`/`selectedModelId` should still populate on the
    // very first fetch.
    applyManifestDiff(c, diff);
  }

  async function checkEligibility(
    address: string,
    target: "model" | "embedding" = "model",
  ): Promise<EligibilityReport> {
    const c = await ensureClient(address);
    const report = await c.checkDeviceEligibility(target);
    eligibilityReport.value = report;
    return report;
  }

  /** Eligibility for one specific model in {@link availableModels}, not
   *  necessarily the selected one — a model-picker row's badge (multi-model
   *  plan §6/§9). Cached per `modelId` in {@link modelEligibilityCache}
   *  (cleared on `manifest:updated`/account switch) so re-rendering an
   *  N-model list doesn't re-run a device-info read N times per render.
   *  Readonly — never mutates `selectedModelId`, same contract as
   *  `LocalAiClient.checkDeviceEligibility(target, modelId)` itself. */
  async function modelEligibility(address: string, modelId: string): Promise<EligibilityReport> {
    const cached = modelEligibilityCache.value[modelId];
    if (cached) return cached;
    const c = await ensureClient(address);
    const report = await c.checkDeviceEligibility("model", modelId);
    modelEligibilityCache.value[modelId] = report;
    return report;
  }

  /** Records the user's model choice (multi-model plan §6 п.2/§9) —
   *  persists through `LocalAiClient.selectModel()` (per-account `kv_store`,
   *  survives restarts) and updates {@link selectedModelId} for reactive UI.
   *  Deliberately does not download/switch anything itself, same contract as
   *  the underlying client method — call `downloadModel()`/`switchModel()`
   *  afterward (both already resolve against whatever's now selected, see
   *  `LocalAiClient.ensureModelReady()`/`switchModel()`'s own doc comments).
   *  @throws If `modelId` isn't an active model in the current manifest. */
  async function selectModel(address: string, modelId: string): Promise<void> {
    const c = await ensureClient(address);
    await c.selectModel(modelId);
    selectedModelId.value = c.getSelectedModelId();
    // A different model may read differently against device thresholds —
    // force checkEligibility()'s next call to re-evaluate, same reasoning
    // as the manifest:updated handler.
    eligibilityReport.value = null;
  }

  /** Reads how much of the model is already on disk from an interrupted
   *  download, without starting/resuming anything — lets `AiModelGate`/
   *  `LocalAiSettingsSection` show "Докачать модель (X%)" instead of
   *  "Скачать модель" when there's real bytes to resume. Call after
   *  `refreshManifest()` (needs a cached manifest to size the percentage
   *  against — resolves `null` without one, same as a fresh device). Never
   *  throws — a failed check just means the button reads as a fresh
   *  download, same as before this existed. */
  async function checkPartialDownload(address: string): Promise<void> {
    const c = await ensureClient(address);
    partialDownload.value = await c.getDownloadProgress("model").catch(() => null);
  }

  /** Flips the UI to "downloading" the instant an explicit tap is handled,
   *  before the async `downloadModel()` chain even starts — chunked
   *  `Range:` requests (`CapacitorRangeDownloadAdapter`) can take a couple
   *  of seconds before their first real `onProgress` tick, during which the
   *  "Скачать"/"Докачать" button otherwise looked like it did nothing.
   *  Seeds the displayed percent from `partialDownload` (bytes already on
   *  disk) rather than hardcoding 0 — a resumed download otherwise visibly
   *  restarted the progress bar from 0% for the couple of seconds before
   *  the transport's first real tick caught back up to where it actually
   *  was, even though the resume itself was already byte-correct at the
   *  transport level. Call sites: `AiModelGate.vue`/
   *  `LocalAiSettingsSection.vue`'s `handleDownload()`, right before
   *  `downloadModel()` — NOT called from
   *  `restoreModelIfPreviouslyDownloaded()`'s background restore path,
   *  which should stay silent unless there's real work to show. */
  function markDownloadStarting(): void {
    const startPercent = partialDownload.value?.percent ?? 0;
    downloadState.value.model.progress = { key: "model", kind: "model", percent: startPercent, status: "pending" };
    // The live progress bar takes over display duties from here — stop
    // showing the pre-download "resume from X%" figure alongside it.
    partialDownload.value = null;
  }

  /** Pauses an in-flight model download — the partial file stays on disk
   *  at whatever byte offset it reached; `resumeDownload()` continues from
   *  there (real byte-offset resume, `CapacitorRangeDownloadAdapter`).
   *  No-op if nothing is downloading right now. */
  async function pauseDownload(address: string): Promise<void> {
    const c = await ensureClient(address);
    await c.pauseModelDownload();
    isPaused.value = true;
  }

  /** Resumes a download paused via `pauseDownload()`. No-op if nothing is
   *  paused. */
  async function resumeDownload(address: string): Promise<void> {
    // Flips before the ensureClient()/resumeModelDownload() awaits, not
    // after — same "update the UI on the same tick as the tap" reasoning as
    // markDownloadStarting(), so the button doesn't sit on "Возобновить"
    // for a beat after being pressed.
    isPaused.value = false;
    const c = await ensureClient(address);
    await c.resumeModelDownload();
  }

  /** Downloads/loads ONLY the model — never the embedding artifact (plan
   *  §6, RAG is out of scope for this integration).
   *  @param configOverride Test seam, forwarded to `ensureClient()` — see its
   *    own doc comment. Production callers omit it. */
  async function downloadModel(address: string, configOverride?: LocalAiConfig): Promise<void> {
    const c = await ensureClient(address, configOverride);
    downloadState.value.model.error = null;
    downloadState.value.model.errorCode = null;
    try {
      await c.ensureModelReady({
        onProgress: (p) => {
          downloadState.value.model.progress = p;
        },
      });
      downloadState.value.model.ready = true;
      downloadState.value.model.progress = null;
      // Defensive: also clear here, not just at this call's own start above
      // — observed live (2026-08-19) that the automatic background
      // restoreModelIfPreviouslyDownloaded() check and an explicit user tap
      // can both call downloadModel() within the same narrow window (the
      // button hasn't disappeared yet because the silent restore hasn't
      // resolved), and whichever call's rejection lands LAST re-sets a
      // stale error even after the OTHER call already reached ready. This
      // doesn't fully close that race (a late failure can still overwrite
      // this), but does mean success always leaves a clean error state at
      // the moment it happens, not just at this call's own entry.
      downloadState.value.model.error = null;
      downloadState.value.model.errorCode = null;
      // Marker written by the runtime:model-loaded event handler above —
      // always fires with the actual model that got loaded, whether that's
      // this call's target or (via ensureModelReady()'s own convergence,
      // multi-model plan §6 п.4) a different one.
    } catch (e) {
      applyDownloadFailure("model", e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  /** Deletes the model entirely — stops any in-flight/paused transfer,
   *  removes the (partial or complete) file, and resets every piece of
   *  local state a fresh device would have, including
   *  {@link MODEL_DOWNLOADED_MARKER_KEY} so a later app restart doesn't try
   *  to silently restore it via `restoreModelIfPreviouslyDownloaded()`. A
   *  later `downloadModel()` call starts completely from scratch. */
  async function deleteModel(address: string): Promise<void> {
    const c = await ensureClient(address);
    await c.deleteModel();
    downloadState.value.model = createEmptyDownloadState();
    partialDownload.value = null;
    isPaused.value = false;
    clearModelDownloadedMarker();
  }

  /** Best-effort, silent restore of `modelReady` on a fresh session — NOT a
   *  substitute for the explicit-click download decision (plan §9 item 3):
   *  only acts when {@link MODEL_DOWNLOADED_MARKER_KEY} proves a previous
   *  session already completed a real download on this device. In that case
   *  `ensureModelReady()` is safe/cheap to call unprompted — the library's
   *  own contract is "a no-op once the model is already loaded", so this
   *  just re-verifies the on-disk file and flips `modelReady` back to `true`
   *  without a fresh multi-GB download. Never throws — a failed restore
   *  (e.g. the file was removed out-of-band) just leaves the ordinary
   *  download gate visible, same as a device that never downloaded.
   *  @param configOverride Test seam, forwarded to `downloadModel()`.
   *    Production callers omit it. */
  async function restoreModelIfPreviouslyDownloaded(address: string, configOverride?: LocalAiConfig): Promise<void> {
    if (downloadState.value.model.ready || downloadState.value.model.progress) return;
    const downloadedModelId = readModelDownloadedMarker();
    if (!downloadedModelId) return;
    const c = await ensureClient(address, configOverride);
    if (c.getSelectedModelId() !== downloadedModelId) {
      // selectModel() was called (this session, or a previous one killed
      // before applying it) without a follow-up download/switch — restore
      // what's actually on disk first, never silently start downloading
      // whatever's merely selected-but-not-yet-applied instead (multi-model
      // plan §8 p.3).
      try {
        await selectModel(address, downloadedModelId);
      } catch {
        // The previously-downloaded model no longer exists/isn't active in
        // the manifest (deprecated/removed upstream) — don't fall through
        // to silently downloading whatever IS selected instead; leave the
        // ordinary download gate visible, same as a device that never
        // downloaded (rare edge case, multi-model plan §8 p.3).
        return;
      }
    }
    await downloadModel(address, configOverride).catch(() => {});
  }

  /** Downloads and swaps in whatever's currently selected (`selectModel()`,
   *  or the manifest's `recommended`/first-active model if nothing was
   *  explicitly chosen) — safe update ordering per the library's own
   *  contract (release old context → verify+load new → delete old file).
   *  Call `refreshManifest()` first if you want to react to
   *  `ManifestDiff.modelChanged` specifically; `switchModel()` itself always
   *  targets the current selection regardless (roadmap 6.3 "Обновить
   *  модель", multi-model plan §6 п.4). */
  async function switchModel(address: string): Promise<void> {
    const c = await ensureClient(address);
    downloadState.value.model.error = null;
    downloadState.value.model.errorCode = null;
    try {
      await c.switchModel({
        onProgress: (p) => {
          downloadState.value.model.progress = p;
        },
      });
      downloadState.value.model.ready = true;
      downloadState.value.model.progress = null;
      // Marker written by the runtime:model-loaded event handler — see
      // downloadModel()'s matching comment.
    } catch (e) {
      applyDownloadFailure("model", e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  /** Releases native runtime contexts + in-memory caches (not files/chats —
   *  see `LocalAiClient.releaseRuntime()`'s own contract). Called on
   *  logout/account switch (roadmap 2.4, 7.2) and optionally on background
   *  (roadmap 7.1). Idempotent. */
  async function releaseRuntime(): Promise<void> {
    creationGeneration++; // invalidate any in-flight ensureClient() creation
    pendingCreation = null;
    clearEventSubscriptions();
    const c = client.value;
    client.value = null;
    currentAddress.value = null;
    downloadState.value = {
      model: createEmptyDownloadState(),
      embedding: createEmptyDownloadState(),
    };
    eligibilityReport.value = null;
    partialDownload.value = null;
    isPaused.value = false;
    isGenerating.value = false;
    availableModels.value = [];
    selectedModelId.value = null;
    modelEligibilityCache.value = {};
    if (c) {
      try {
        await c.releaseRuntime({ closeDatabase: true });
      } catch (e) {
        console.warn("[LocalAi] releaseRuntime failed:", e);
      }
    }
  }

  return {
    client,
    supportReport,
    eligibilityReport,
    downloadState,
    modelReady,
    currentModel,
    availableModels,
    selectedModelId,
    partialDownload,
    isPaused,
    isGenerating,
    initError,
    checkSupportOnce,
    ensureClient,
    refreshManifest,
    checkEligibility,
    modelEligibility,
    selectModel,
    checkPartialDownload,
    markDownloadStarting,
    pauseDownload,
    resumeDownload,
    downloadModel,
    deleteModel,
    switchModel,
    restoreModelIfPreviouslyDownloaded,
    releaseRuntime,
  };
});
