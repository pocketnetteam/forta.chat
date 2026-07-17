import { isNative } from "@/shared/lib/platform";

const STORAGE_KEY = "bastyon-chat-share-data";

export interface ExternalShareData {
  text?: string;
  fileUri?: string;
  fileName?: string;
  mimeType?: string;
}

/** Read a shared file URI into a Blob.
 *
 *  Android Share Sheet hands us `content://` URIs (and occasionally
 *  `file://` paths from older OEMs) which the WebView's `fetch()` cannot
 *  open — `fetch` returns a `TypeError: Failed to fetch` and the upload
 *  silently dies (issue #650). Routing through Capacitor Filesystem reads
 *  the bytes via the native bridge, then we wrap them in a Blob the rest
 *  of the upload pipeline already knows how to handle.
 *
 *  On the web (browser PWA) the URL is a regular http(s) — fall through
 *  to plain `fetch`. */
export async function readShareUriAsBlob(uri: string, mimeType: string): Promise<Blob> {
  const isNativeUri = uri.startsWith("content://") || uri.startsWith("file://");
  if (isNativeUri && isNative) {
    const { Filesystem } = await import("@capacitor/filesystem");
    const result = await Filesystem.readFile({ path: uri });
    // On native, `data` is base64-encoded; on the web fallback it's already a Blob.
    if (typeof result.data === "string") {
      const binary = atob(result.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mimeType });
    }
    return result.data;
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

/** Read and clear deferred share data */
export function consumeShareData(): ExternalShareData | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  localStorage.removeItem(STORAGE_KEY);
  try {
    return JSON.parse(raw) as ExternalShareData;
  } catch {
    return null;
  }
}

/** Copy a shared file into the app's private cache directory and return the
 *  new file URI. Android 14+ revokes the content:// UriPermission grant as
 *  soon as the calling app loses foreground — by the time the user picks a
 *  target room and taps Send, the original URI can already be `Permission
 *  Denied`. Copying once at `shareReceived` time freezes the bytes inside
 *  our own sandbox so they survive both the UriPermission revoke and the
 *  ForwardPicker hop (Session 48 / #710 #717). */
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

let listenerRegistered = false;

/** Initialize the share target listener (call once on app mount, native only).
 *  Calls `onShare` when content is received from Android Share Sheet.
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

    // Text / URL
    if (event.texts?.length) {
      data.text = event.texts.join("\n");
    }

    // First file only (single-file sharing)
    if (event.files?.length) {
      const file = event.files[0];
      try {
        data.fileUri = await copyShareToCache(file);
      } catch (e) {
        // Best-effort: large videos can OOM Filesystem.readFile on low-RAM
        // devices; fall back to the original URI so the sender at least has
        // a chance to read it before the permission revoke kicks in.
        console.error("[share-target] cache copy failed, falling back to original URI:", e);
        data.fileUri = file.uri;
      }
      data.fileName = file.name;
      data.mimeType = file.mimeType;
    }

    if (data.text || data.fileUri) {
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
