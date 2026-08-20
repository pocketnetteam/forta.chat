import type { DownloadTransportPort, FileSystemPort, Unsubscribe } from "local-ai";
import { ModelDownloader } from "./model-download-plugin";

interface TaskRecord {
  url: string;
  destinationPath: string;
  headers?: Record<string, string>;
}

/**
 * `DownloadTransportPort` backed by `ModelDownloadService.kt` — a real
 * Android foreground service doing the same byte-offset-resume `Range:`
 * loop `CapacitorRangeDownloadAdapter` does in JS, except one that keeps
 * running when the user leaves the app. See `docs/decisions.md`'s
 * "background download" entry: the JS-only adapter is a pure WebView loop
 * with nothing backing it once the app is deprioritised/killed by Android —
 * this replaces it on Android specifically for that reason.
 *
 * The Capacitor plugin bridge (`ModelDownloader.addListener`) is
 * inherently async (`Promise<PluginListenerHandle>`), but
 * `DownloadTransportPort.onProgress()`/`onCompleted()`/`onFailed()` must
 * return an `Unsubscribe` synchronously (`DownloadEngine.runOneAttempt()`
 * registers them before `start()` is even called). Subscribes to the native
 * plugin's events exactly once, relaying to this adapter's own
 * synchronous `Set`-based listener registries — same two-layer structure
 * `CapacitorRangeDownloadAdapter` already uses, just relaying native events
 * instead of driving the HTTP loop itself.
 *
 * `resume(id)` — the port contract only passes an `id`, not the original
 * url/destinationPath, so `tasks` remembers what `start()` was called with
 * (same reason `CapacitorRangeDownloadAdapter` keeps its own task Map).
 * The native side has no distinct "resume" action either — see
 * `ModelDownloadService`'s doc comment — calling `start()` again with the
 * same `destinationPath` naturally continues from however many bytes are
 * already there.
 */
export class NativeForegroundDownloadAdapter implements DownloadTransportPort {
  readonly supportsResume = true;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly progressListeners = new Set<(e: { id: string; progressPercent: number }) => void>();
  private readonly completedListeners = new Set<(e: { id: string }) => void>();
  private readonly failedListeners = new Set<(e: { id: string; error: string }) => void>();
  private subscribePromise: Promise<void> | null = null;

  constructor(private readonly fileSystem: FileSystemPort) {}

  private ensureSubscribed(): Promise<void> {
    if (!this.subscribePromise) {
      this.subscribePromise = (async () => {
        await ModelDownloader.addListener("progress", (e) => {
          for (const cb of this.progressListeners) cb(e);
        });
        await ModelDownloader.addListener("completed", (e) => {
          for (const cb of this.completedListeners) cb(e);
        });
        await ModelDownloader.addListener("failed", (e) => {
          for (const cb of this.failedListeners) cb(e);
        });
      })();
    }
    return this.subscribePromise;
  }

  async start(task: { id: string; url: string; destinationPath: string; headers?: Record<string, string> }): Promise<void> {
    // Registering the native listeners must complete BEFORE telling the
    // service to start — otherwise an early progress tick could fire before
    // this adapter is relaying anything.
    await this.ensureSubscribed();
    this.tasks.set(task.id, { url: task.url, destinationPath: task.destinationPath, headers: task.headers });
    await ModelDownloader.start(task);
  }

  async pause(id: string): Promise<void> {
    await ModelDownloader.pause({ id });
  }

  async resume(id: string): Promise<void> {
    const record = this.tasks.get(id);
    if (!record) return; // nothing to resume — matches CapacitorRangeDownloadAdapter's own no-op contract
    await ModelDownloader.start({ id, url: record.url, destinationPath: record.destinationPath, headers: record.headers });
  }

  async stop(id: string, options?: { discardPartial?: boolean }): Promise<void> {
    await ModelDownloader.stop({ id });
    if (options?.discardPartial) {
      const record = this.tasks.get(id);
      if (record) await this.fileSystem.deleteFile(record.destinationPath).catch(() => undefined);
    }
    this.tasks.delete(id);
  }

  async status(id: string): Promise<{ state: "pending" | "running" | "paused" | "done" | "error"; progressPercent: number; errorMessage?: string }> {
    return ModelDownloader.status({ id });
  }

  onProgress(cb: (e: { id: string; progressPercent: number }) => void): Unsubscribe {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }

  onCompleted(cb: (e: { id: string }) => void): Unsubscribe {
    this.completedListeners.add(cb);
    return () => this.completedListeners.delete(cb);
  }

  onFailed(cb: (e: { id: string; error: string }) => void): Unsubscribe {
    this.failedListeners.add(cb);
    return () => this.failedListeners.delete(cb);
  }
}
