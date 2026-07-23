import Capacitor
import Foundation

/// iOS counterpart to the Android `TorFilePlugin.kt`. On iOS we do **not**
/// route through Tor (project decision: no Tor on iOS). Instead the plugin
/// uses `URLSession` to talk directly to the homeserver over HTTPS while
/// preserving the exact JS-bridge surface the Android plugin exposes:
///
///   * Plugin name `"TorFile"` (see `IOSTorFilePlugin.m`) so
///     `registerPlugin<TorFilePlugin>('TorFile')` in
///     `src/shared/lib/file-transfer/file-transfer-service.ts` resolves to
///     the iOS implementation transparently.
///   * `upload` resolves with `{ contentUri, statusCode }`.
///   * `download` resolves with `{ filePath, mimeType, size }` and writes
///     the payload to a temp file inside `cachesDirectory` — same layout
///     Android uses (`context.cacheDir`).
///   * Progress is reported via the `progress` event with the same
///     `{ percent, loaded, total }` payload Android emits, plus an optional
///     `id` that the JS side can use to demultiplex concurrent transfers
///     (Android does not yet emit `id`; the JS listener tolerates both).
///
/// Why a custom Swift plugin at all (vs. WKWebView `fetch`):
///
///   * `fetch` in WKWebView does not expose reliable upload progress.
///   * Matrix media uploads can reach hundreds of MB; routing them through
///     a `Blob` in JS creates real WebView memory pressure on lower-end
///     iPhones. `URLSession.uploadTask(fromFile:)` streams from disk.
///   * Leaves a clean integration point if iOS Tor ever becomes a thing.
///
/// Background `URLSession` (transfers that survive app suspension) is
/// deliberately deferred to v2 — see plan doc Task 3.
@objc(IOSTorFilePlugin)
public class IOSTorFilePlugin: CAPPlugin, URLSessionDataDelegate, URLSessionTaskDelegate {

    /// Per-task bookkeeping so the delegate callbacks can correlate a
    /// completing `URLSessionTask` back to the JS `CAPPluginCall` that
    /// started it. All access happens on `delegateQueue` (main), so a
    /// plain dictionary is enough — no locking needed.
    private struct TaskState {
        let call: CAPPluginCall
        /// Optional progress identifier surfaced through the `progress`
        /// event so the JS side can demultiplex concurrent transfers
        /// (per-message uploads scrolling through a chat). Empty string
        /// means "caller did not pass an id".
        let progressId: String
        /// Set on uploads (so we know the file size up front and can
        /// report meaningful percentages even before the response
        /// header arrives). Updated on downloads after the response
        /// `Content-Length` lands.
        var totalBytes: Int64
        /// Destination on disk for downloads. `nil` on uploads.
        let destination: URL?
        /// Buffer for the response body. For uploads the homeserver
        /// returns a small JSON blob (the `mxc://…` URI); for downloads
        /// this holds the full file payload until completion writes it
        /// to `destination`.
        var responseBody: Data
    }

    /// `URLSessionTask.taskIdentifier` → bookkeeping. Only mutated on
    /// the main queue (delegateQueue) so unsynchronised access is safe.
    private var tasks: [Int: TaskState] = [:]

    /// `URLSession` configured with our delegate. Lazy so the delegate
    /// reference is `self` (CAPPlugin's lifecycle owns us; the bridge
    /// retains the plugin while the JS layer holds a registration).
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        // 60s for the request to start receiving response, 10min to
        // complete a single resource. Matrix media uploads on slow 3G
        // can take several minutes; resource-level timeout above is
        // the upper bound before we fail the upload outright.
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 600
        // Prefer Wi-Fi but fall back to cellular if needed. Matches
        // the Android default behaviour — large file uploads should
        // not silently wait for a Wi-Fi network.
        config.allowsCellularAccess = true
        // Pin delegate callbacks to the main queue so the dictionary
        // mutations above need no extra synchronisation.
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()

    // MARK: - Upload

    @objc func upload(_ call: CAPPluginCall) {
        guard let filePathStr = call.getString("filePath") else {
            call.reject("filePath required"); return
        }
        guard let uploadUrlStr = call.getString("uploadUrl"),
              let uploadUrl = URL(string: uploadUrlStr) else {
            call.reject("uploadUrl required"); return
        }
        let mimeType = call.getString("mimeType") ?? "application/octet-stream"
        let auth = call.getString("authorization") ?? ""
        let progressId = call.getString("id") ?? ""

        // JS callers may pass either a bare filesystem path or a
        // `file://` URL (Capacitor's @capacitor/filesystem returns
        // `file://` URIs). Accept both — anything else is an error.
        let fileURL: URL
        if filePathStr.hasPrefix("file://"), let u = URL(string: filePathStr) {
            fileURL = u
        } else {
            fileURL = URL(fileURLWithPath: filePathStr)
        }

        let attrs: [FileAttributeKey: Any]
        do {
            attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        } catch {
            call.reject("file not found at \(fileURL.path): \(error.localizedDescription)")
            return
        }
        let fileSize = (attrs[.size] as? NSNumber)?.int64Value ?? 0

        var req = URLRequest(url: uploadUrl)
        req.httpMethod = "POST"
        req.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        req.setValue(String(fileSize), forHTTPHeaderField: "Content-Length")
        if !auth.isEmpty {
            req.setValue(auth, forHTTPHeaderField: "Authorization")
        }

        let task = session.uploadTask(with: req, fromFile: fileURL)
        registerTask(
            task,
            call: call,
            progressId: progressId,
            totalBytes: fileSize,
            destination: nil
        )
        task.resume()
    }

    // MARK: - Download

    @objc func download(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"),
              let url = URL(string: urlStr) else {
            call.reject("url required"); return
        }
        let auth = call.getString("authorization") ?? ""
        let progressId = call.getString("id") ?? ""

        var req = URLRequest(url: url)
        if !auth.isEmpty {
            req.setValue(auth, forHTTPHeaderField: "Authorization")
        }

        let task = session.dataTask(with: req)
        // `totalBytes` starts at 0; the actual size lands in
        // `urlSession(_:dataTask:didReceive:completionHandler:)` once
        // the response header arrives. The destination filename is
        // chosen at completion time once we know the MIME type —
        // mirroring the Android plugin's `download_<timestamp>.<ext>`
        // layout in `cacheDir`.
        let dest = makeDownloadDestination()
        registerTask(
            task,
            call: call,
            progressId: progressId,
            totalBytes: 0,
            destination: dest
        )
        task.resume()
    }

    private func makeDownloadDestination() -> URL {
        let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        // Final extension is patched in `didCompleteWithError` once the
        // response MIME type is known. Until then we land on `.bin`,
        // matching Android's fallback in `guessMimeExtension`.
        return cache.appendingPathComponent("download_\(Int(Date().timeIntervalSince1970 * 1000)).bin")
    }

    // MARK: - Bookkeeping

    private func registerTask(
        _ task: URLSessionTask,
        call: CAPPluginCall,
        progressId: String,
        totalBytes: Int64,
        destination: URL?
    ) {
        // `keepAlive = true` so the bridge does not free the call when
        // its synchronous handler returns — we resolve it asynchronously
        // from the delegate completion callback.
        call.keepAlive = true
        tasks[task.taskIdentifier] = TaskState(
            call: call,
            progressId: progressId,
            totalBytes: totalBytes,
            destination: destination,
            responseBody: Data()
        )
    }

    private func emitProgress(state: TaskState, loaded: Int64, total: Int64) {
        // Match Android's `JSObject` shape so the JS listener does not
        // need to branch per platform. `id` is included only when the
        // caller passed one — Android does not emit it yet, and the
        // JS listener tolerates absent `id` by accepting all events.
        var payload: [String: Any] = [
            "percent": total > 0 ? Int((loaded * 100) / total) : 0,
            "loaded": loaded,
            "total": total,
        ]
        if !state.progressId.isEmpty {
            payload["id"] = state.progressId
        }
        notifyListeners("progress", data: payload)
    }

    // MARK: - URLSessionDataDelegate (download)

    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        if var state = tasks[dataTask.taskIdentifier] {
            if let http = response as? HTTPURLResponse, http.expectedContentLength > 0 {
                state.totalBytes = http.expectedContentLength
                tasks[dataTask.taskIdentifier] = state
            }
        }
        completionHandler(.allow)
    }

    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive data: Data
    ) {
        guard var state = tasks[dataTask.taskIdentifier] else { return }
        state.responseBody.append(data)
        tasks[dataTask.taskIdentifier] = state
        let loaded = Int64(state.responseBody.count)
        // Total may still be 0 if the homeserver omitted Content-Length;
        // emitProgress reports 0% in that case rather than dividing by
        // zero. Android behaves the same way (skips the notify).
        if state.totalBytes > 0 {
            emitProgress(state: state, loaded: loaded, total: state.totalBytes)
        }
    }

    // MARK: - URLSessionTaskDelegate (upload progress + completion)

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard let state = tasks[task.taskIdentifier] else { return }
        // `totalBytesExpectedToSend` may be `NSURLSessionTransferSizeUnknown`
        // (-1) for chunked uploads. Fall back to the file size we recorded
        // at task creation in that case so the percentage stays sensible.
        let total = totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : state.totalBytes
        emitProgress(state: state, loaded: totalBytesSent, total: total)
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard let state = tasks.removeValue(forKey: task.taskIdentifier) else { return }
        let call = state.call
        // `keepAlive` was set when the task started; release the bridge
        // slot once we have either resolved or rejected.
        defer { call.keepAlive = false }

        if let error = error {
            call.reject("network error: \(error.localizedDescription)", nil, error)
            return
        }

        let http = task.response as? HTTPURLResponse
        let status = http?.statusCode ?? 0

        if let dest = state.destination {
            // Download path. Match Android's contract:
            //   * Reject on non-2xx so the JS layer's existing
            //     "Download failed: <status>" detection (see
            //     use-file-download.ts looksLikeNetworkTransient) keeps
            //     working unchanged.
            //   * Resolve with `{ filePath, mimeType, size }` so callers
            //     don't need a per-platform branch.
            guard (200..<300).contains(status) else {
                call.reject("Download failed: HTTP \(status)")
                return
            }
            let mime = http?.mimeType ?? "application/octet-stream"
            let finalDest = patchExtensionIfNeeded(dest, mime: mime)
            do {
                try state.responseBody.write(to: finalDest, options: .atomic)
            } catch {
                call.reject("write failed: \(error.localizedDescription)", nil, error)
                return
            }
            let size = (try? FileManager.default.attributesOfItem(atPath: finalDest.path)[.size] as? NSNumber)?.int64Value ?? Int64(state.responseBody.count)
            call.resolve([
                "filePath": finalDest.path,
                "mimeType": mime,
                "size": size,
            ])
            return
        }

        // Upload path. Match Android: 2xx → resolve with the response
        // body verbatim under `contentUri` (Synapse returns a JSON
        // blob containing `content_uri`; the JS side parses it).
        guard (200..<300).contains(status) else {
            call.reject("Upload failed: HTTP \(status)")
            return
        }
        let body = String(data: state.responseBody, encoding: .utf8) ?? ""
        call.resolve([
            "contentUri": body,
            "statusCode": status,
        ])
    }

    /// Rename the temp `download_*.bin` placeholder to a proper extension
    /// once we know the response MIME type. Mirrors Android's
    /// `guessMimeExtension`. Returns the new URL on success, the original
    /// on any failure (caller still gets a usable file).
    private func patchExtensionIfNeeded(_ url: URL, mime: String) -> URL {
        let ext = guessExtension(for: mime)
        guard ext != ".bin" else { return url }
        let renamed = url.deletingPathExtension().appendingPathExtension(String(ext.dropFirst()))
        do {
            try FileManager.default.moveItem(at: url, to: renamed)
            return renamed
        } catch {
            return url
        }
    }

    private func guessExtension(for mime: String) -> String {
        let m = mime.lowercased()
        if m.contains("jpeg") || m.contains("jpg") { return ".jpg" }
        if m.contains("png") { return ".png" }
        if m.contains("gif") { return ".gif" }
        if m.contains("webp") { return ".webp" }
        if m.contains("mp4") { return ".mp4" }
        if m.contains("webm") { return ".webm" }
        if m.contains("ogg") { return ".ogg" }
        if m.contains("pdf") { return ".pdf" }
        return ".bin"
    }
}
