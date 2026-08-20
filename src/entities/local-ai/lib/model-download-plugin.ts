import { registerPlugin } from "@capacitor/core";

/**
 * Bridge to the native `ModelDownloadPlugin.kt` (Android) — a real
 * foreground service (`ModelDownloadService.kt`) doing the same
 * byte-offset-resume `Range:` download loop `CapacitorRangeDownloadAdapter`
 * does in JS, except one that survives the app being backgrounded. See
 * `native-foreground-download.adapter.ts`'s doc comment and
 * `docs/decisions.md`'s "background download" entry for why this exists —
 * a pure-JS `CapacitorHttp` loop inside the WebView gets throttled/killed
 * once the user leaves the app, which the old adapter never actually
 * survived despite the download being byte-resumable in principle.
 *
 * iOS has no equivalent plugin yet — `create-client.ts` only wires this in
 * on Android; iOS keeps `CapacitorRangeDownloadAdapter`.
 */
export interface ModelDownloaderPlugin {
  /** Also doubles as "resume" — see `ModelDownloadService`'s doc comment:
   *  starting again with the same `destinationPath` naturally continues
   *  from however many bytes are already there. */
  start(options: { id: string; url: string; destinationPath: string; headers?: Record<string, string> }): Promise<void>;
  pause(options: { id: string }): Promise<void>;
  stop(options: { id: string }): Promise<void>;
  status(options: { id: string }): Promise<{
    state: "pending" | "running" | "paused" | "done" | "error";
    progressPercent: number;
    errorMessage?: string;
  }>;
  /** Native-speed SHA-256 — see `ModelDownloadPlugin.kt`'s `verify()` doc
   *  comment for why this exists instead of always going through
   *  `@capacitor/filesystem`'s bridge (~1.9 hours for a 2.3GB file,
   *  confirmed live 2026-08-19, vs. low single-digit seconds native). */
  verify(options: { id: string; path: string; expectedSha256: string }): Promise<{ valid: boolean }>;
  addListener(
    event: "progress",
    cb: (data: { id: string; progressPercent: number }) => void,
  ): Promise<{ remove: () => void }>;
  addListener(event: "completed", cb: (data: { id: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: "failed", cb: (data: { id: string; error: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: "verifyProgress", cb: (data: { id: string; bytesHashed: number }) => void): Promise<{ remove: () => void }>;
}

export const ModelDownloader = registerPlugin<ModelDownloaderPlugin>("ModelDownloader");
