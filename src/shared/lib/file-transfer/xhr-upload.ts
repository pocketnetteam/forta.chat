export interface XhrUploadOptions {
  url: string;
  authorization: string;
  blob: Blob;
  contentType: string;
  onProgress: (progress: { loaded: number; total: number }) => void;
  signal?: AbortSignal;
}

/**
 * POST a blob with XMLHttpRequest and report upload progress.
 *
 * matrix-js-sdk-bastyon uploads through `fetch` (its XHR branch is switched
 * off), and fetch reports no upload progress, so every file outside the
 * native Tor path sat at 0 % until it was sent. Resolves with the response
 * body; rejects with an Error naming the HTTP status (sync-engine's
 * isUploadFatal reads it) or a DOMException("AbortError") on cancel.
 */
export function uploadBlobWithProgress(options: XhrUploadOptions): Promise<string> {
  const { url, authorization, blob, contentType, onProgress, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = (): void => xhr.abort();
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);

    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", authorization);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (ev) => {
      onProgress({ loaded: ev.loaded, total: ev.lengthComputable ? ev.total : blob.size });
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText);
        return;
      }
      let detail = "";
      try {
        const body = JSON.parse(xhr.responseText) as { errcode?: string; error?: string };
        detail = [body.errcode, body.error].filter(Boolean).join(": ");
      } catch {
        // Not JSON — the status alone has to do.
      }
      reject(new Error(`Upload failed: status ${xhr.status}${detail ? ` (${detail})` : ""}`));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Upload failed: network error"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(blob);
  });
}
