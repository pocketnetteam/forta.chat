import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { LocalAiClient, LocalAiConfig, ModelArtifact, PlatformSupportPort } from "local-ai";

import { createLocalAiConfig, createPlatformSupportPort } from "../lib/create-client";
import { createEmptyDownloadState, type EligibilityReport, type SupportReport } from "./types";

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
  /** Current manifest's model artifact metadata (displayName/paramsB/quant/
   *  sizeBytes) — Settings → Local AI display (roadmap 6.3). Populated by
   *  `refreshManifest()` and kept in sync via the `manifest:updated` event;
   *  `null` until the manifest has been fetched at least once. */
  const currentModel = ref<ModelArtifact | null>(null);

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

  function subscribeToEvents(c: LocalAiClient): void {
    clearEventSubscriptions();
    unsubscribers.push(
      c.on("download:progress", (progress) => {
        downloadState.value[progress.kind].progress = progress;
        if (progress.status === "completed") {
          downloadState.value[progress.kind].error = null;
        }
      }),
      c.on("download:completed", ({ kind }) => {
        downloadState.value[kind].ready = true;
        downloadState.value[kind].progress = null;
        downloadState.value[kind].error = null;
      }),
      c.on("download:failed", ({ kind, error }) => {
        downloadState.value[kind].error = error.message;
      }),
      c.on("manifest:updated", (diff) => {
        // Cached manifest changed — eligibility may now read differently
        // against the new artifact, force a re-check next time it's asked.
        eligibilityReport.value = null;
        currentModel.value = diff.model.to;
      }),
      c.on("manifest:invalid", ({ error }) => {
        initError.value = error.message;
      }),
      c.on("device:eligibility-warning", (report) => {
        eligibilityReport.value = report;
      }),
    );
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
    // but `currentModel` should still populate on the very first fetch.
    currentModel.value = diff.model.to;
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

  /** Downloads/loads ONLY the model — never the embedding artifact (plan
   *  §6, RAG is out of scope for this integration). */
  async function downloadModel(address: string): Promise<void> {
    const c = await ensureClient(address);
    downloadState.value.model.error = null;
    try {
      await c.ensureModelReady({
        onProgress: (p) => {
          downloadState.value.model.progress = p;
        },
      });
      downloadState.value.model.ready = true;
      downloadState.value.model.progress = null;
    } catch (e) {
      downloadState.value.model.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /** Downloads and swaps in whatever `manifest.model` currently is — safe
   *  update ordering per the library's own contract (release old context →
   *  verify+load new → delete old file). Call `refreshManifest()` first if
   *  you want to react to `ManifestDiff.modelChanged` specifically;
   *  `switchModel()` itself always targets the current manifest regardless
   *  (roadmap 6.3 "Обновить модель"). */
  async function switchModel(address: string): Promise<void> {
    const c = await ensureClient(address);
    downloadState.value.model.error = null;
    try {
      await c.switchModel({
        onProgress: (p) => {
          downloadState.value.model.progress = p;
        },
      });
      downloadState.value.model.ready = true;
      downloadState.value.model.progress = null;
    } catch (e) {
      downloadState.value.model.error = e instanceof Error ? e.message : String(e);
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
    isGenerating.value = false;
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
    isGenerating,
    initError,
    checkSupportOnce,
    ensureClient,
    refreshManifest,
    checkEligibility,
    downloadModel,
    switchModel,
    releaseRuntime,
  };
});
