import { ref, onScopeDispose, type Ref } from "vue";
import { useAuthStore } from "@/entities/auth";
import type { FileInfo, Message } from "@/entities/chat";
import { getMatrixClientService } from "@/entities/matrix";
import type { PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { isNative, isElectron, isAndroid } from "@/shared/lib/platform";
import { sanitizeFileName } from "@/shared/lib/file-name-sanitizer";
import { useBugReport } from "@/features/bug-report";
import { tRaw } from "@/shared/lib/i18n";
import { useToast } from "@/shared/lib/use-toast";
import {
  CryptoNotReadyError,
  isNetworkBlocked,
  MediaUnavailableError,
  MissingUrlError,
  NetworkBlockedError,
} from "@/shared/lib/network/typed-network-errors";
import { waitForRoomCrypto } from "@/entities/matrix/model/wait-for-crypto";
import { enqueueDecrypt } from "./decrypt-queue";
import { getMediaCache, type MediaCacheCategory } from "@/shared/lib/media-cache";
import { MessageType } from "@/entities/chat";

/** Classify a message into the Settings → Storage tab buckets.
 *  - `media` = photos + videos + video circles
 *  - `voice` = audio messages (Forta only ships voice notes via audio)
 *  - `file`  = catch-all for documents, archives, anything else
 *  We rely on MessageType primarily; mime is a secondary signal for the
 *  rare case where senders mis-set the type (e.g. an old client uploading
 *  audio as a generic file). */
function classifyForCache(messageType: MessageType, mime: string | undefined): MediaCacheCategory {
  switch (messageType) {
    case MessageType.image:
    case MessageType.video:
    case MessageType.videoCircle:
      return "media";
    case MessageType.audio:
      return "voice";
    case MessageType.file: {
      const top = (mime ?? "").split("/")[0]?.toLowerCase() ?? "";
      if (top === "image" || top === "video") return "media";
      if (top === "audio") return "voice";
      return "file";
    }
    default:
      return "file";
  }
}

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

/** Options for `download()`. `forceRefetch` is the retry-after-watchdog
 *  escape hatch: when a stuck encrypted blob never reaches loadedmetadata,
 *  the user clicks retry and the call site sets this flag to drop the
 *  cached objectUrl and rerun fetch + decrypt with a fresh URL. */
export interface DownloadOpts {
  forceRefetch?: boolean;
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
  if (
    err instanceof NetworkBlockedError ||
    err instanceof MediaUnavailableError ||
    err instanceof CryptoNotReadyError
  ) {
    return true;
  }
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
 *  Returns false for crypto failures (always user-actionable, never a bug),
 *  for our own typed transient/region errors (those already show a clear
 *  user message — auto-bug-report on top is just noise), and for repeats of
 *  the same (messageId, error) within the dedup window. */
function shouldAutoReport(messageKey: string, err: unknown): boolean {
  if (isCryptoError(err)) return false;
  if (
    err instanceof CryptoNotReadyError ||
    err instanceof NetworkBlockedError ||
    err instanceof MediaUnavailableError ||
    err instanceof MissingUrlError
  ) {
    return false;
  }
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

/** Toast duration for typed transient errors. 5s gives the user enough time
 *  to read the message but doesn't dwell so long that it overlaps with the
 *  next action they take. */
const TYPED_ERROR_TOAST_MS = 5_000;

/** Toast dedup window — keyed by (cacheKey, errorKey). Surface the same
 *  user-facing toast at most once per window per message. Without dedup,
 *  Vue re-renders (e.g. virtual scroller recycling, parent re-key cascades
 *  from unrelated reactive updates like a chat-list refresh) call download()
 *  again for already-failed media, and each failure re-fires the toast —
 *  visible as repeated "Server unreachable" notifications during routine
 *  navigation. */
const TOAST_DEDUP_WINDOW_MS = 60_000;
const TOAST_DEDUP_PRUNE_THRESHOLD = 500;
const toastDedupMap = new Map<string, number>();

function pruneToastDedup(): void {
  if (toastDedupMap.size < TOAST_DEDUP_PRUNE_THRESHOLD) return;
  const cutoff = Date.now() - TOAST_DEDUP_WINDOW_MS;
  for (const [k, ts] of toastDedupMap) {
    if (ts < cutoff) toastDedupMap.delete(k);
  }
}

/** TEST-ONLY: clear the toast dedup map between test cases. */
export function _resetToastDedupForTests(): void {
  toastDedupMap.clear();
}

/** Show a localised toast when a download failure resolves to one of our
 *  typed transient errors. Silent for everything else — generic errors are
 *  still surfaced via the in-bubble retry UI and the auto-bug-report flow.
 *  Deduped per (cacheKey, errorKey) within TOAST_DEDUP_WINDOW_MS so that
 *  repeated re-attempts during the same network glitch do not spam the user. */
function surfaceTypedErrorToast(err: unknown, cacheKey: string): void {
  let key:
    | "errors.networkBlocked"
    | "errors.cryptoNotReady"
    | "errors.mediaUnavailable"
    | "errors.missingUrl"
    | null = null;
  if (err instanceof NetworkBlockedError) key = "errors.networkBlocked";
  else if (err instanceof CryptoNotReadyError) key = "errors.cryptoNotReady";
  else if (err instanceof MediaUnavailableError) key = "errors.mediaUnavailable";
  else if (err instanceof MissingUrlError) key = "errors.missingUrl";
  if (!key) return;

  pruneToastDedup();
  const dedupKey = `${cacheKey}:${key}`;
  const now = Date.now();
  const last = toastDedupMap.get(dedupKey) ?? 0;
  if (now - last < TOAST_DEDUP_WINDOW_MS) return;
  toastDedupMap.set(dedupKey, now);

  try {
    useToast().toast(tRaw(key), "error", TYPED_ERROR_TOAST_MS);
  } catch (toastErr) {
    // useToast() requires a Vue effect scope; in unusual runtime paths
    // (worker contexts, headless tests without scope) it may throw.
    // Don't let a failed toast mask the original download error.
    console.warn("[use-file-download] toast surface failed:", toastErr);
  }
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

/** Monotonic counter so two cache-bust values produced inside the same
 *  millisecond (Date.now() granularity) still differ. Without this, fast
 *  back-to-back retries can collide on the same `cb=` value, defeating the
 *  Service-Worker / CDN bust. */
let cacheBustCounter = 0;

/** Append a cache-bust query parameter on retry attempts. The first attempt
 *  (`attempt === 0`) is left pristine: server-side caches only matter once
 *  we've already seen a confirmed miss, and polluting the canonical URL
 *  hurts CDN hit rates. Retries (`attempt >= 1`) get a unique `cb=` so
 *  Service Workers, browser HTTP cache, and intermediate proxies all
 *  re-resolve instead of replaying the prior failure.
 *
 *  `blob:` and `data:` URIs are left untouched: query strings are not part of
 *  their grammar, so appending `?cb=...` would mangle the URL and break the
 *  fetch. Those schemes also bypass HTTP caches by construction — there is
 *  nothing to bust. */
export function appendCacheBust(url: string, attempt: number): string {
  if (attempt <= 0) return url;
  if (url.startsWith("blob:") || url.startsWith("data:")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}cb=${Date.now()}_${++cacheBustCounter}`;
}

/** Resolve a Matrix `mxc://` URI to an HTTP download URL via the active
 *  Matrix client. Non-mxc inputs (`https://`, `blob:`, `data:`) pass through
 *  unchanged — those are already directly fetchable.
 *
 *  Returns `null` only when the input is `mxc://` and the Matrix client
 *  cannot resolve it (no client / no baseUrl). Callers treat null as a
 *  terminal media-unavailable failure: nothing the retry loop can do.
 *
 *  Called fresh on every retry attempt so transient client state changes
 *  (homeserver baseUrl rotation, access-token refresh) take effect between
 *  attempts. Historically the download path passed `fileInfo.url` straight
 *  to `fetch`, and for encrypted attachments from non-Bastyon clients
 *  (Element / Cinny / forwarded messages) that URL is `mxc://...`, which
 *  Capacitor's WebView shim rejects with `TypeError: Failed to fetch`. That
 *  one missing translation accounts for the largest media-failure cluster
 *  on the bug board (forta-bugs #776 #763 #648 #513 #475 #441 #373). */
export function resolveMediaUrl(url: string): string | null {
  if (!url.startsWith("mxc://")) return url;
  try {
    return getMatrixClientService().mxcToHttp(url);
  } catch {
    // Matrix service not yet initialised (cold start race) — treat as a
    // resolve miss; the outer error path surfaces MediaUnavailableError.
    return null;
  }
}

/** True for failures that look like a network/server issue we should label
 *  as such (5xx, timeouts, AbortError, fetch-network errors). Used to scope
 *  `wrapTransientError`: only network-shaped errors get re-cast into
 *  `MediaUnavailableError`. Generic application errors (e.g. QuotaExceeded,
 *  unexpected exceptions inside the decrypt path) pass through unchanged so
 *  the auto-bug-report flow still fires for them. */
function looksLikeNetworkTransient(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof TypeError) {
    // \bload failed\b prevents accidental matches against our own
    // "Download failed: 5xx" path-style errors.
    return /failed to fetch|networkerror|\bload failed\b/i.test(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /Download failed:\s*5\d{2}|timeout/i.test(msg);
}

/** Wrap a final transient failure (after retries are exhausted) into a typed
 *  error so callers can branch on instanceof checks instead of regexing
 *  message strings.
 *
 *   - `NetworkBlockedError` — "request never reached the server" (region /
 *     firewall / offline).
 *   - `CryptoNotReadyError` — keys still loading; bubbles through unchanged
 *     so the UI can show "wait" UX.
 *   - `MediaUnavailableError` — 5xx / timeout / AbortError persisting after
 *     retries.
 *
 *  Anything else is *not* wrapped: a generic `Error("QuotaExceeded")` from
 *  the decrypt path is more useful as itself than re-cast as media-
 *  unavailable, both for `console.error` traces and for bug-report dedup. */
export function wrapTransientError(err: unknown, mxcUrl: string): Error {
  if (
    err instanceof NetworkBlockedError ||
    err instanceof MediaUnavailableError ||
    err instanceof CryptoNotReadyError
  ) {
    return err;
  }
  if (isNetworkBlocked(err)) return new NetworkBlockedError(err);
  if (looksLikeNetworkTransient(err)) return new MediaUnavailableError(mxcUrl, err);
  return err instanceof Error ? err : new Error(String(err));
}

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
  if (!fileInfo.url) throw new MissingUrlError();
  // Local-only schemes (blob:, data:) never reach the homeserver — they
  // are an optimistic placeholder set by createLocal that should have
  // been overwritten by confirmMediaSent once the upload completes. If
  // we still see one here, the upload was aborted, crashed mid-flight,
  // or the row predates the WEE-28 send-shape fix. fetch(blob:) on a
  // document that no longer owns that blob throws a Security Error,
  // which `wrapTransientError` then miscategorises as a network failure
  // and the retry loop pointlessly burns 10s of spinner UI. Fast-fail
  // with MissingUrlError so the UI surfaces "no usable file URL" and
  // the user gets a meaningful state instead of an endless retry.
  if (fileInfo.url.startsWith("blob:") || fileInfo.url.startsWith("data:")) {
    throw new MissingUrlError();
  }
  if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1] ?? 6000));
    }

    try {
      // Download the file (with hard timeout to avoid indefinite MIUI/Tor stalls).
      // Resolve mxc:// → http on every attempt so a fresh homeserver baseUrl /
      // access-token rotation takes effect between retries. Without this,
      // encrypted attachments from non-Bastyon clients (forta-bugs #776 #763
      // #648 #513 #475 #441 #373) carry raw mxc:// URIs that fetch() rejects
      // with TypeError: Failed to fetch on every attempt.
      // On retry attempts, append a cache-bust so Service Workers / CDN edges
      // don't replay the prior failure response (issues #648, #641, #637).
      const resolvedUrl = resolveMediaUrl(fileInfo.url);
      if (resolvedUrl === null) {
        // Cannot translate mxc:// — Matrix client missing or unknown baseUrl.
        // This is terminal: the retry budget will hit the same null every time.
        throw new MediaUnavailableError(fileInfo.url);
      }
      const fetchUrl = appendCacheBust(resolvedUrl, attempt);
      const response = await fetchWithTimeout(fetchUrl, signal);
      if (!response.ok) {
        const err = new Error(`Download failed: ${response.status}`);
        // Mark non-retriable codes so the catch block below can throw immediately
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any).status = response.status;
        throw err;
      }
      let blob = await response.blob();

      // If the file has secrets, we need to decrypt it.
      // Race against Matrix sync: if the user opens an E2E chat right after
      // login, `pcrypto.rooms[roomId]` may not yet be populated. Park briefly
      // for it to materialise instead of immediately failing the attempt
      // (issue #616). On timeout, CryptoNotReadyError bubbles up and the
      // outer retry loop gets one more shot.
      if (fileInfo.secrets?.keys) {
        const authStore = useAuthStore();
        const roomCrypto = await waitForRoomCrypto(
          roomId,
          () => authStore.pcrypto?.rooms[roomId] as PcryptoRoomInstance | undefined,
        );

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
      // Crypto-not-ready already paid 5 s of polling inside waitForRoomCrypto.
      // Re-entering the outer retry loop would burn another 1+3+6 s × 5 s of
      // polling = up to ~40 s before the user sees an error. Fast-fail and
      // let the user pull-to-refresh once Matrix sync has actually settled —
      // the toast tells them what's going on.
      if (e instanceof CryptoNotReadyError) throw e;
      // Don't retry on permanent errors (missing URL, 4xx client errors)
      if (e instanceof MissingUrlError) throw e;
      // mxc:// could not be resolved to an http URL (no Matrix client, no
      // baseUrl). Every retry will hit the same null — fast-fail.
      if (e instanceof MediaUnavailableError) throw e;
      if (e instanceof Error) {
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

  // Retries exhausted — surface a typed error so the UI can show the right
  // message (region-block UX vs. generic media-unavailable UX) instead of
  // a bare TypeError stringified into the toast.
  throw wrapTransientError(lastError, fileInfo.url);
}

/** Resolve a decrypted Blob for a media message without touching the per-event
 *  cache or rendering pipeline. Used by the forward path: when the user picks
 *  «Forward» on an image/video/file message, we need the decrypted bytes so
 *  we can wrap them in a `File` and re-upload through `sendImage`/`sendFile`
 *  (preserving forward attribution). The download composable's public
 *  `download()` is unsuitable because it returns an `objectUrl` and mutates
 *  per-message UI state — forward is a one-shot byte access with no UI
 *  side effects.
 *
 *  Returns null when there is no source bytes available (no fileInfo at all,
 *  or a local blob URL whose object has already been revoked). Throws on
 *  network/crypto failures so the caller can surface a clear toast. */
export async function getDecryptedBlobForMessage(
  message: Pick<Message, "fileInfo" | "roomId" | "senderId" | "timestamp">,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const fileInfo = message.fileInfo;
  if (!fileInfo) return null;

  // Local blob URL fast path: the original message was sent from this device
  // and its optimistic blob is still alive. Fetching `blob:` is synchronous-ish
  // and skips the whole download/decrypt loop.
  if (fileInfo.url?.startsWith("blob:")) {
    try {
      const res = await fetch(fileInfo.url, signal ? { signal } : undefined);
      if (res.ok) return await res.blob();
    } catch (e) {
      // Caller cancellation is terminal — don't fall through to a server fetch.
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // Blob URL was revoked between snapshot and forward — fall through to
      // server-side download below if there's anything to download.
    }
  }

  // Server-side mxc URL — reuse the full retry + decrypt pipeline.
  return await downloadAndDecrypt(
    fileInfo,
    message.roomId,
    message.senderId,
    message.timestamp,
    signal,
  );
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

/** Save media to the Android gallery / Downloads folder via the native
 *  SaveMediaPlugin (MediaStore.insert). Session 58 replaces the prior
 *  FileOpener + Share fallback path that silently degraded to a Share
 *  dialog on Android 14+ scoped storage. */
async function saveFileAndroid(objectUrl: string, fileName: string, mimeType: string) {
  const { registerPlugin } = await import("@capacitor/core");
  const SaveMedia = registerPlugin<{
    save(opts: { base64: string; fileName: string; mimeType: string }): Promise<{ uri: string; path: string }>;
  }>("SaveMedia");

  const response = await fetch(objectUrl);
  const blob = await response.blob();
  const base64 = await blobToBase64(blob);

  // Defence against path traversal / control chars in sender-supplied
  // file names — `fileName` ultimately comes from a Matrix event.
  await SaveMedia.save({ base64, fileName: sanitizeFileName(fileName), mimeType });
}

/** iOS save path — write to Documents and hand off to the system viewer
 *  / Share Sheet. iOS UX expects a Share Sheet, so the legacy pipeline
 *  remains intentional here. Android takes a different path via
 *  `saveFileAndroid`. */
async function saveFileIOS(objectUrl: string, fileName: string, mimeType?: string) {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { FileOpener } = await import("@capacitor-community/file-opener");

  const response = await fetch(objectUrl);
  const blob = await response.blob();
  const base64 = await blobToBase64(blob);

  // Defence against path traversal / control chars in sender-supplied
  // file names — `fileName` ultimately comes from a Matrix event.
  const safeName = sanitizeFileName(fileName);

  const result = await Filesystem.writeFile({
    path: safeName,
    data: base64,
    directory: Directory.Cache,
  });

  const contentType = mimeType || guessMime(safeName);

  try {
    await FileOpener.open({
      filePath: result.uri,
      contentType,
      openWithDefault: true,
    });
  } catch (openError) {
    console.warn("[saveFile] native open failed, trying share:", openError);
    const { Share } = await import("@capacitor/share");
    await Share.share({
      title: safeName,
      url: result.uri,
      dialogTitle: safeName,
    });
  }
}

/** Route to the platform-specific native save path. */
async function saveFileNative(objectUrl: string, fileName: string, mimeType?: string) {
  const resolvedMime = mimeType || guessMime(fileName);
  if (isAndroid) {
    await saveFileAndroid(objectUrl, fileName, resolvedMime);
  } else {
    await saveFileIOS(objectUrl, fileName, resolvedMime);
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
   *                  chat switch) should pass `onScopeDispose`-tied signal.
   *  @param opts.forceRefetch — when true, drops the cached objectUrl,
   *                  revokes the prior blob URL, and re-runs the full
   *                  fetch + decrypt pipeline. Used by the voice-message
   *                  retry button after a watchdog timeout (Session 44). */
  const download = async (
    message: Message,
    signal?: AbortSignal,
    opts: DownloadOpts = {},
  ) => {
    if (!message.fileInfo) return null;

    // Use _key (stable clientId) if available, otherwise fall back to id.
    // This prevents cache misses when id flips from clientId to eventId after send confirmation.
    const cacheKey = message._key || message.id;

    // forceRefetch — drop the prior cache entry and revoke the old blob URL
    // before re-running the pipeline. Without revoking, the previous
    // objectUrl would leak (no one else holds a reference to it). Also
    // invalidate the persistent media cache so the retry actually re-fetches
    // from the network instead of returning the same stale bytes.
    if (opts.forceRefetch) {
      const previousUrl = cache.get(cacheKey);
      if (previousUrl) {
        try { URL.revokeObjectURL(previousUrl); } catch { /* ignore */ }
      }
      cache.delete(cacheKey);
      const mxc = message.fileInfo.url;
      if (mxc) {
        getMediaCache()?.delete(mxc).catch(() => { /* non-fatal */ });
      }
      const existingState = states.value[cacheKey];
      if (existingState) {
        existingState.objectUrl = null;
        existingState.blob = null;
        existingState.error = null;
        existingState.errorKind = null;
      }
    }

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

    // Fast path: persistent media cache hit (Telegram/WhatsApp-style).
    // Cacheable when the source is a remote URL we can stably key by —
    // any `mxc://` or `http(s)://`. Local schemes (`blob:` / `data:`) are
    // already local bytes the seedLocalUrl path or direct fetch handles
    // for free, so caching them gains nothing and pollutes the index.
    // Cache lookup failures are swallowed: a missing cache layer just falls
    // through to the network path with no user-visible difference.
    const mxc = message.fileInfo.url;
    const isCacheableUrl = !!mxc &&
      (mxc.startsWith("mxc://") || mxc.startsWith("http://") || mxc.startsWith("https://"));
    const mediaCache = getMediaCache();
    if (mediaCache && isCacheableUrl) {
      try {
        const cachedBlob = await mediaCache.get(mxc);
        if (cachedBlob) {
          const mimeType = message.fileInfo.type || cachedBlob.type || "application/octet-stream";
          const typedBlob = cachedBlob.type === mimeType
            ? cachedBlob
            : new Blob([cachedBlob], { type: mimeType });
          const url = URL.createObjectURL(typedBlob);
          state.objectUrl = url;
          state.blob = typedBlob;
          state.loading = false;
          cache.set(cacheKey, url);
          return url;
        }
      } catch (cacheErr) {
        console.warn("[use-file-download] media cache read failed:", cacheErr);
      }
    }

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

      // Persist decrypted bytes so the next chat-open hits the disk cache
      // instead of re-downloading + re-decrypting. Local schemes have
      // nothing meaningful to persist. Errors here are non-fatal: the
      // user already has their blob URL.
      if (mediaCache && isCacheableUrl) {
        mediaCache.put(mxc!, typedBlob, {
          roomId: message.roomId,
          category: classifyForCache(message.type, mimeType),
          fileName: message.fileInfo.name,
        }).catch((err) => {
          console.warn("[use-file-download] media cache write failed:", err);
        });
      }

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
      // Surface a localised toast for our typed transient failures so the
      // user sees a clear "what to do next" message (region/firewall vs.
      // media-gone vs. keys-still-syncing) instead of just an in-bubble
      // retry button. Deduped per (cacheKey, errorKey) so background
      // re-attempts during the same glitch do not spam.
      surfaceTypedErrorToast(e, cacheKey);
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
