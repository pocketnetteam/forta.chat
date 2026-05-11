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

/** Initialize the share target listener (call once on app mount, native only).
 *  Calls `onShare` when content is received from Android Share Sheet. */
export async function initShareTargetListener(
  onShare: (data: ExternalShareData) => void,
): Promise<void> {
  if (!isNative) return;

  const { CapacitorShareTarget } = await import("@capgo/capacitor-share-target");

  await CapacitorShareTarget.addListener("shareReceived", (event) => {
    const data: ExternalShareData = {};

    // Text / URL
    if (event.texts?.length) {
      data.text = event.texts.join("\n");
    }

    // First file only (single-file sharing)
    if (event.files?.length) {
      const file = event.files[0];
      data.fileUri = file.uri;
      data.fileName = file.name;
      data.mimeType = file.mimeType;
    }

    if (data.text || data.fileUri) {
      onShare(data);
    }
  });
}
