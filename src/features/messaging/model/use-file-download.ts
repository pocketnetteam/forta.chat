import { ref, onScopeDispose, type Ref } from "vue";
import { useAuthStore } from "@/entities/auth";
import type { FileInfo, Message } from "@/entities/chat";
import type { PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { isNative, isElectron } from "@/shared/lib/platform";
import { useBugReport } from "@/features/bug-report";
import { tRaw } from "@/shared/lib/i18n";
import { enqueueDecrypt } from "./decrypt-queue";

/** Coarse classification of a download/decrypt failure for UI branching.
 *  - `crypto` — AES-SIV / membership / decryption failure; the user should
 *               ask the sender to resend. Not an actionable bug.
 *  - `network` — fetch / timeout / 5xx; usually transient.
 *  - `unknown` — anything else (default before classification). */
export type FileDownloadErrorKind = "crypto" | "network" | "unknown" | null;

interface FileDownloadState {
  loading: boolean;
  error: string | null;
  errorKind: FileDownloadErrorKind;
  objectUrl: string | null;
  blob: Blob | null;
}

/** Errors that mean "this ciphertext cannot be decrypted with the keys we
 *  have" — the sender's room state and ours diverged, or they encrypted to
 *  the wrong recipient set. Surfacing these as bug-reports drowns the actual
 *  signal: the user should retry or ask the sender to resend, not file a bug.
 *
 *  Source patterns (informational, not exhaustive):
 *   - `AES-SIV: ciphertext verification failure!` — miscreant.SIV.open()
 *   - `ciphertext verification` — generic miscreant phrasing
 *   - `emptyforme` — body has no entry for this user (stale recipient set)
 *   - `no encrypted payload for this user` — same condition, friendlier text */
const CRYPTO_ERROR_PATTERNS: RegExp[] = [
  /AES-SIV/i,
  /ciphertext verification/i,
  /\bemptyforme\b/i,
  /no encrypted payload for this user/i,
];

function isCryptoError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return CRYPTO_ERROR_PATTERNS.some((re) => re.test(msg));
}

/** Coarse 5xx / fetch-failure / timeout classifier. We deliberately *don't*
 *  match the bare word "network" — too many unrelated error messages mention
 *  it in passing. Instead we rely on:
 *   - `DOMException(AbortError)` — fetch timeout / user-cancel.
 *   - `TypeError: Failed to fetch` (Chrome) / `NetworkError when attempting to
 *     fetch resource` (Firefox) / `Load failed` (Safari) — connectivity loss.
 *   - 5xx HTTP responses — server-side transient failure. */
function isNetworkError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof TypeError) {
    return /failed to fetch|networkerror|load failed/i.test(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /Download failed:\s*5\d{2}|timeout/i.test(msg);
}

function classifyError(err: unknown): FileDownloadErrorKind {
  if (isCryptoError(err)) return "crypto";
  if (isNetworkError(err)) return "network";
  return "unknown";
}

/** Stable hash of an error for dedup keys — short, message-only. */
function errorHash(err: unknown): string {
  if (err instanceof Error) return `${err.name}:${err.message.slice(0, 80)}`;
  return String(err).slice(0, 80);
}

/** Per-message dedup window for automatic bug-reports. One real failure
 *  used to fan out into 12 identical reports (issues #290–300, #312)
 *  through retry + visibilitychange + re-mount paths. */
const BUG_REPORT_DEDUP_WINDOW_MS = 5 * 60_000;
/** Soft cap before prune kicks in. The map only holds (messageKey, errorHash)
 *  → timestamp; 500 entries is ~70 KB. Long-running Electron sessions could
 *  otherwise grow this unbounded across hours. */
const BUG_REPORT_DEDUP_PRUNE_THRESHOLD = 500;
const bugReportDedupMap = new Map<string, number>();

/** Drop entries whose timestamp is older than the dedup window. Cheap O(N)
 *  pass triggered only when the map exceeds the soft cap, so the common path
 *  stays O(1). */
function pruneDedupMap(): void {
  if (bugReportDedupMap.size < BUG_REPORT_DEDUP_PRUNE_THRESHOLD) return;
  const cutoff = Date.now() - BUG_REPORT_DEDUP_WINDOW_MS;
  for (const [key, ts] of bugReportDedupMap) {
    if (ts < cutoff) bugReportDedupMap.delete(key);
  }
}

/** Decide whether a download error should auto-open the bug-report modal.
 *  Returns false for crypto failures (always user-actionable, never a bug)
 *  and for repeats of the same (messageId, error) within the dedup window. */
function shouldAutoReport(messageKey: string, err: unknown): boolean {
  if (isCryptoError(err)) return false;
  pruneDedupMap();
  const key = `${messageKey}:${errorHash(err)}`;
  const last = bugReportDedupMap.get(key) ?? 0;
  const now = Date.now();
  if (now - last < BUG_REPORT_DEDUP_WINDOW_MS) return false;
  bugReportDedupMap.set(key, now);
  return true;
}

/** TEST-ONLY: clear the dedup map between test cases. */
export function _resetBugReportDedupForTests(): void {
  bugReportDedupMap.clear();
}

/** Cache of already-decrypted file object URLs: eventId → objectUrl */
const cache = new Map<string, string>();

/** Revoke all cached blob URLs and clear the cache */
export function revokeAllFileUrls() {
  for (const url of cache.values()) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  cache.clear();
}

/** Remove a specific entry from the download cache (e.g. before blob URL revocation) */
export function invalidateDownloadCache(key: string) {
  cache.delete(key);
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 6000]; // 1s, 3s, 6s

/** Hard timeout for a single fetch attempt. MIUI / Tor routinely keep TCP
 *  connections open with no data forever — unmitigated this hangs the UI
 *  indefinitely. 30s is long enough for slow 3G but short enough to surface
 *  a clear error to the user. */
const FETCH_TIMEOUT_MS = 30_000;

/** Non-retriable HTTP status codes — fast-fail instead of burning the
 *  retry budget on a guaranteed-failure response. */
const NON_RETRIABLE_STATUSES = new Set([400, 401, 403, 404, 410, 415]);

/** Fetch a URL with a hard timeout. Caller's AbortSignal is honored if
 *  provided. Returns the Response or throws AbortError on timeout. */
async function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const abortOuter = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", abortOuter, { once: true });
  }
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortOuter);
  }
}

/** Download and optionally decrypt a file from the Matrix server.
 *  Retries up to MAX_RETRIES times on transient failures (network, crypto not ready).
 *
 *  @param signal — optional external AbortSignal. When this signal aborts
 *                  the in-flight fetch is torn down immediately and no
 *                  further retry attempts are made. */
async function downloadAndDecrypt(
  fileInfo: FileInfo,
  roomId: string,
  senderId: string,
  timestamp: number,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!fileInfo.url) throw new Error("No file URL");
  if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1] ?? 6000));
    }

    try {
      // Download the file (with hard timeout to avoid indefinite MIUI/Tor stalls)
      const response = await fetchWithTimeout(fileInfo.url, signal);
      if (!response.ok) {
        const err = new Error(`Download failed: ${response.status}`);
        // Mark non-retriable codes so the catch block below can throw immediately
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any).status = response.status;
        throw err;
      }
      let blob = await response.blob();

      // If the file has secrets, we need to decrypt it
      if (fileInfo.secrets?.keys) {
        const authStore = useAuthStore();
        const roomCrypto = authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined;
        if (!roomCrypto) throw new Error("No room crypto for decryption");

        // Build event-like object for decryptKey.
        // decryptKey reads secrets from either content.keys, content.info.secrets,
        // or content.pbody.secrets (backward-compat with old bastyon-chat format),
        // so we surface the secret under both `info` and `pbody` paths to cover
        // messages written by either schema generation.
        const hexSender = hexEncode(senderId).toLowerCase();
        const event: Record<string, unknown> = {
          content: {
            info: { secrets: fileInfo.secrets },
            pbody: { secrets: fileInfo.secrets },
          },
          sender: hexSender,
          origin_server_ts: timestamp,
        };

        const decryptKey = await roomCrypto.decryptKey(event);
        // Serialise decryption: parallel decryptFile calls on low-end
        // Android WebViews saturate the CPU and freeze the UI.
        // Pass the declared plaintext MIME so new ciphertexts (stored as
        // application/octet-stream) restore with the right type instead
        // of falling through to a generic binary fallback.
        const decryptedFile = await enqueueDecrypt(() =>
          roomCrypto.decryptFile(blob, decryptKey, fileInfo.type),
        );
        blob = decryptedFile;
      }

      return blob;
    } catch (e) {
      lastError = e;
      // User cancel is terminal — no retries.
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // Crypto failures (AES-SIV MAC, emptyforme, etc.) are deterministic for a
      // given ciphertext + key set. Retrying burns 1+3+6=10s of spinner UI on
      // top of an already failed decrypt — and the retry will produce the same
      // error. Fast-fail so the friendly "ask sender to resend" UX appears
      // immediately.
      if (isCryptoError(e)) throw e;
      // Don't retry on permanent errors (missing URL, 4xx client errors)
      if (e instanceof Error) {
        if (e.message === "No file URL") throw e;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const status = (e as any).status as number | undefined;
        if (status !== undefined && NON_RETRIABLE_STATUSES.has(status)) throw e;
        // Legacy substring match in case status wasn't attached
        if (e.message.includes("404") || e.message.includes("403") || e.message.includes("415")) {
          throw e;
        }
      }
      // Retry on transient errors (network, crypto not ready, timeout, etc.)
    }
  }

  throw lastError;
}

/** Convert Blob to base64 data string (without the data:...;base64, prefix) */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  rar: "application/x-rar-compressed",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

function guessMime(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Write file to device cache and open with system viewer (Android/iOS). */
async function saveFileNative(objectUrl: string, fileName: string, mimeType?: string) {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { FileOpener } = await import("@capacitor-community/file-opener");

  const response = await fetch(objectUrl);
  const blob = await response.blob();
  const base64 = await blobToBase64(blob);

  const result = await Filesystem.writeFile({
    path: fileName,
    data: base64,
    directory: Directory.Cache,
  });

  const contentType = mimeType || guessMime(fileName);

  try {
    await FileOpener.open({
      filePath: result.uri,
      contentType,
      openWithDefault: true,
    });
  } catch (openError) {
    console.warn("[saveFile] native open failed, trying share:", openError);
    // Fallback: offer system share sheet
    const { Share } = await import("@capacitor/share");
    await Share.share({
      title: fileName,
      url: result.uri,
      dialogTitle: fileName,
    });
  }
}

/** Composable for downloading and decrypting files/images */
export function useFileDownload() {
  const states = ref<Record<string, FileDownloadState>>({});

  // Auto-cleanup blob URLs when the composable's effect scope is destroyed
  onScopeDispose(() => {
    revokeAllFileUrls();
  });

  const getState = (eventId: string): FileDownloadState => {
    if (!states.value[eventId]) {
      states.value[eventId] = {
        loading: false,
        error: null,
        errorKind: null,
        objectUrl: cache.get(eventId) ?? null,
        blob: null,
      };
    }
    return states.value[eventId];
  };

  /** Download (and decrypt if needed) a file message.
   *  @param signal — optional AbortSignal. Callers that want the download
   *                  to stop when their scope unmounts (e.g. MediaGrid on
   *                  chat switch) should pass `onScopeDispose`-tied signal. */
  const download = async (message: Message, signal?: AbortSignal) => {
    if (!message.fileInfo) return null;

    // Use _key (stable clientId) if available, otherwise fall back to id.
    // This prevents cache misses when id flips from clientId to eventId after send confirmation.
    const cacheKey = message._key || message.id;

    // Already cached
    if (cache.has(cacheKey)) {
      const state = getState(cacheKey);
      state.objectUrl = cache.get(cacheKey)!;
      return state.objectUrl;
    }

    const state = getState(cacheKey);
    if (state.loading) return; // Already downloading

    state.loading = true;
    state.error = null;
    state.errorKind = null;

    try {
      const blob = await downloadAndDecrypt(
        message.fileInfo,
        message.roomId,
        message.senderId,
        message.timestamp,
        signal,
      );
      const mimeType = message.fileInfo.type || "application/octet-stream";
      const typedBlob = new Blob([blob], { type: mimeType });
      const url = URL.createObjectURL(typedBlob);

      state.objectUrl = url;
      state.blob = typedBlob;
      cache.set(cacheKey, url);

      return url;
    } catch (e) {
      // User-initiated cancel is not an error for bug reporting — just bail.
      if (e instanceof DOMException && e.name === "AbortError") {
        state.error = null;
        state.errorKind = null;
        return null;
      }
      console.error("[use-file-download] download error:", e);
      state.errorKind = classifyError(e);
      state.error = String(e);
      // Skip auto-report for crypto failures (user-actionable, not a bug) and
      // for duplicates within the dedup window. Manual reporting is still
      // available via the bug-report button in the friendly error UI.
      if (shouldAutoReport(cacheKey, e)) {
        useBugReport().open({ context: tRaw("bugReport.ctx.fileDownload"), error: e });
      }
      return null;
    } finally {
      state.loading = false;
    }
  };

  /** Seed the cache with a local blob URL (e.g. for pending voice messages).
   *  This avoids the full download+decrypt pipeline for files we already have locally. */
  const seedLocalUrl = (cacheKey: string, blobUrl: string) => {
    if (cache.has(cacheKey)) return;
    cache.set(cacheKey, blobUrl);
    const state = getState(cacheKey);
    state.objectUrl = blobUrl;
    state.loading = false;
    state.error = null;
  };

  /** Download file to device and open with native viewer (Android/iOS)
   *  or trigger browser/Electron save dialog. */
  const saveFile = async (objectUrl: string, fileName: string, mimeType?: string) => {
    if (isNative) {
      await saveFileNative(objectUrl, fileName, mimeType);
      return;
    }

    if (isElectron) {
      const electronAPI = (window as any).electronAPI;
      if (electronAPI?.saveFile) {
        try {
          const response = await fetch(objectUrl);
          const buffer = await response.arrayBuffer();
          await electronAPI.saveFile(fileName, buffer);
          return;
        } catch (e) {
          console.warn("[saveFile] electron IPC failed, falling back to <a>:", e);
        }
      }
    }

    // Web / Electron fallback
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  /** Format file size for display */
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
  };

  return {
    states: states as Ref<Record<string, FileDownloadState>>,
    getState,
    download,
    seedLocalUrl,
    saveFile,
    formatSize,
  };
}
