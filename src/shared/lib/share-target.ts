import { Capacitor } from "@capacitor/core";
import { isNative } from "@/shared/lib/platform";

const STORAGE_KEY = "bastyon-chat-share-data";

export interface ExternalShareFile {
  uri: string;
  name: string;
  mimeType: string;
}

export interface ExternalShareData {
  text?: string;
  files?: ExternalShareFile[];
}

/** Single-file shape persisted to localStorage by builds before multi-file
 *  sharing — still read back so a share pending across an update isn't lost. */
interface LegacyShareData {
  fileUri?: string;
  fileName?: string;
  mimeType?: string;
}

/** `content://` (Android provider), `file://`, or a bare absolute path —
 *  the capgo plugin (Android) and our Share Extension (iOS) both hand over
 *  bare paths to the copy they made inside the app sandbox. */
function isNativeFileUri(uri: string): boolean {
  return uri.startsWith("content://") || uri.startsWith("file://") || uri.startsWith("/");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Map a native file reference to the WebView local-server URL. Path segments
 *  are re-encoded so names containing `#`, `?` or `%` don't truncate the URL. */
function toWebViewUrl(uri: string): string {
  if (uri.startsWith("content://")) return Capacitor.convertFileSrc(uri);
  const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(safeDecode(segment)))
    .join("/");
  return Capacitor.convertFileSrc(encoded);
}

async function readViaFilesystem(uri: string, mimeType: string): Promise<Blob> {
  const { Filesystem } = await import("@capacitor/filesystem");
  const result = await Filesystem.readFile({ path: uri });
  // On native, `data` is base64-encoded; on the web fallback it's already a Blob.
  if (typeof result.data !== "string") return result.data;
  const binary = atob(result.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/** Read a shared file into a Blob.
 *
 *  Native files are streamed through the WebView's local server
 *  (`Capacitor.convertFileSrc`). `Filesystem.readFile` moves the whole file
 *  over the bridge as a base64 string — ~1.33× the size, decoded again in a
 *  JS loop — which made screenshot shares crawl and OOM'd large files on old
 *  Android WebViews. It stays as the fallback when the local server can't
 *  serve the file.
 *
 *  On the web (browser PWA) the URL is a regular http(s) — plain `fetch`. */
export async function readShareUriAsBlob(uri: string, mimeType: string): Promise<Blob> {
  if (isNative && isNativeFileUri(uri)) {
    try {
      const response = await fetch(toWebViewUrl(uri));
      if (response.ok) {
        const blob = await response.blob();
        if (blob.size > 0) {
          return blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
        }
      }
    } catch (e) {
      console.warn("[share-target] local-server read failed, falling back to Filesystem:", e);
    }
    return readViaFilesystem(uri, mimeType);
  }
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Share fetch failed: ${response.status}`);
  }
  return response.blob();
}

/** Save share data to localStorage for deferred processing (cold start / not authed) */
export function saveShareData(data: ExternalShareData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function normalizeShareData(data: ExternalShareData & LegacyShareData): ExternalShareData {
  const { fileUri, fileName, mimeType, ...rest } = data;
  if (!fileUri || rest.files?.length) return rest;
  return {
    ...rest,
    files: [
      {
        uri: fileUri,
        name: fileName || "shared_file",
        mimeType: mimeType || "application/octet-stream",
      },
    ],
  };
}

/** Read and clear deferred share data */
export function consumeShareData(): ExternalShareData | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  localStorage.removeItem(STORAGE_KEY);
  try {
    return normalizeShareData(JSON.parse(raw) as ExternalShareData & LegacyShareData);
  } catch {
    return null;
  }
}

/** Copy a `content://` file into the app's private cache directory and return
 *  the new file URI. Android 14+ revokes the UriPermission grant as soon as
 *  the calling app loses foreground — by the time the user picks a target
 *  room and taps Send, the original URI can already be `Permission Denied`
 *  (Session 48 / #710 #717). */
async function copyShareToCache(file: { uri: string; name: string }): Promise<string> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  // Sanitize filename — Filesystem rejects path separators, and a leaked
  // `..` would let a hostile sender write outside CacheDirectory.
  const safeName =
    file.name
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^\.+/, "") || "shared_file";
  const cachedName = `share-${Date.now()}-${safeName}`;
  const read = await Filesystem.readFile({ path: file.uri });
  // Native Filesystem.readFile always returns base64-encoded string on
  // Android. A Blob here means we're on a web path that shouldn't be
  // hitting this function — bail loudly so the outer try/catch falls back
  // to the original URI instead of silently writing an empty cache file.
  if (typeof read.data !== "string") {
    throw new Error("share-target: expected base64 string from Filesystem.readFile, got Blob");
  }
  await Filesystem.writeFile({
    path: cachedName,
    data: read.data,
    directory: Directory.Cache,
  });
  const cached = await Filesystem.getUri({ path: cachedName, directory: Directory.Cache });
  return cached.uri;
}

/** The native side has normally already copied the bytes into our sandbox
 *  (Android `cache/shared_files`, iOS App Group `share-inbox`) and hands over
 *  a plain path — re-copying it through the base64 bridge only tripled the
 *  memory cost. A `content://` URI means that native copy failed and we
 *  still hold a revocable grant, so only then copy it ourselves. */
async function resolveSharedFile(file: ExternalShareFile): Promise<ExternalShareFile> {
  const resolved: ExternalShareFile = { uri: file.uri, name: file.name, mimeType: file.mimeType };
  if (!file.uri.startsWith("content://")) return resolved;
  try {
    resolved.uri = await copyShareToCache(file);
  } catch (e) {
    // Best-effort: fall back to the original URI so the sender at least has
    // a chance to read it before the permission revoke kicks in.
    console.error("[share-target] cache copy failed, falling back to original URI:", e);
  }
  return resolved;
}

let listenerRegistered = false;

/** Initialize the share target listener (call once on app mount, native only).
 *  Calls `onShare` when content is received from the system Share Sheet.
 *
 *  Idempotent — `singleTask` launchMode can re-deliver Intents to an existing
 *  MainActivity, so the bootstrap path may run twice in one process. Without
 *  the guard the capgo bridge ends up with two listeners and dispatches
 *  `onShare` twice per share. */
export async function initShareTargetListener(
  onShare: (data: ExternalShareData) => void,
): Promise<void> {
  if (!isNative || listenerRegistered) return;
  listenerRegistered = true;

  const { CapacitorShareTarget } = await import("@capgo/capacitor-share-target");

  await CapacitorShareTarget.addListener("shareReceived", async (event) => {
    const data: ExternalShareData = {};

    if (event.texts?.length) {
      data.text = event.texts.join("\n");
    }

    if (event.files?.length) {
      const files: ExternalShareFile[] = [];
      // Sequential: a content:// fallback copy goes through base64 — doing
      // several in parallel is what OOMs low-RAM devices.
      for (const file of event.files) {
        files.push(await resolveSharedFile(file));
      }
      data.files = files;
    }

    if (data.text || data.files?.length) {
      onShare(data);
    }
  });
}

/** Reset the idempotent guard so successive tests can re-register the
 *  listener against a fresh capgo mock. Production code must not call this —
 *  it bypasses the singleton protection the singleTask launchMode relies on.
 *  @internal */
export function __resetShareTargetListenerForTests(): void {
  listenerRegistered = false;
}
