# iOS TorFile → Direct HTTPS Fallback Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Parent plan:** `2026-05-12-ios-overall-plan.md`
**Companion plan:** `2026-05-12-ios-simple-tasks.md` (Tor JS-stubs section)

**Goal:** Provide a working file upload/download path on iOS without Tor. Reuse the existing `TorFile` JS bridge surface so callers (`file-transfer-service.ts`, `use-file-download.ts`) need no platform-specific logic.

---

## Critical reassessment

### Plugin landscape

- **`@capacitor/filesystem`** (already a dep) — file I/O. Keep using it for read/write of media payloads.
- **No Capacitor HTTP client plugin is needed** — WKWebView's `fetch` works fine for HTTPS uploads/downloads, including streaming, when the file is already in JS as a Blob/ArrayBuffer.

### Why a custom Swift plugin at all?

The Android `TorFilePlugin.kt` does three things:

1. Wraps an HTTP client through SOCKS-proxy `127.0.0.1:8181` (Tor reverse-proxy).
2. Streams large files to disk to avoid OOM in the WebView.
3. Reports progress events to JS.

On iOS without Tor, (1) is moot. (2) and (3) **could** be done in JS via `fetch` + `ReadableStream` + the `progress` event, **but**:

- WKWebView's `fetch` doesn't expose upload progress events reliably.
- For files >50MB the WebView memory pressure is real (matrix media uploads can be hundreds of MB).

So a small Swift plugin (~120 LOC) using `URLSession.uploadTask(withStreamedRequest:)` + `URLSessionTaskDelegate` for accurate `didSendBodyData` / `didReceiveData` callbacks is the right call. It also leaves us a clean integration point if iOS Tor ever becomes a thing.

### Bridge contract — match Android

Keep the same `TorFile` plugin name, methods, and event shapes:

```typescript
interface TorFilePlugin {
  upload(opts: { filePath: string; uploadUrl: string; mimeType: string; authorization?: string }):
    Promise<{ ok: boolean; status: number; body: string }>;
  download(opts: { url: string; destPath: string; authorization?: string }):
    Promise<{ ok: boolean; status: number; size: number; path: string }>;
  addListener(ev: 'uploadProgress' | 'downloadProgress',
              cb: (data: { id: string; loaded: number; total: number }) => void):
    Promise<{ remove: () => void }>;
}
```

Existing JS callers (`file-transfer-service.ts`) work unchanged when this plugin is present — we just install the iOS implementation under the same name.

---

## Tasks

### Task 1: Define the iOS Swift plugin skeleton

**Files (new):**
- `ios/App/App/IOSTorFilePlugin.swift`
- `ios/App/App/IOSTorFilePlugin.m`

**Step 1: Plugin skeleton (~120 LOC)**

```swift
import Capacitor
import Foundation

@objc(IOSTorFilePlugin)
public class IOSTorFilePlugin: CAPPlugin, URLSessionDataDelegate, URLSessionTaskDelegate {
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 600
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()
    // taskID -> CAPPluginCall mapping
    private var inflight: [Int: CAPPluginCall] = [:]
    // taskID -> { id, total, dest? }
    private var meta: [Int: (id: String, total: Int64, dest: URL?)] = [:]
    // taskID -> received data buffer (uploads return server response in body)
    private var responseData: [Int: Data] = [:]

    // --- upload ---

    @objc func upload(_ call: CAPPluginCall) {
        guard let filePathStr = call.getString("filePath"),
              let uploadUrlStr = call.getString("uploadUrl"),
              let uploadUrl = URL(string: uploadUrlStr) else {
            call.reject("filePath and uploadUrl required"); return
        }
        let mime = call.getString("mimeType") ?? "application/octet-stream"
        let auth = call.getString("authorization") ?? ""
        let id = call.getString("id") ?? UUID().uuidString
        let url = URL(string: filePathStr) ?? URL(fileURLWithPath: filePathStr)
        guard let fileSize = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int64 else {
            call.reject("file not found at \(url.path)"); return
        }
        var req = URLRequest(url: uploadUrl)
        req.httpMethod = "POST"
        req.setValue(mime, forHTTPHeaderField: "Content-Type")
        if !auth.isEmpty { req.setValue(auth, forHTTPHeaderField: "Authorization") }
        let task = session.uploadTask(with: req, fromFile: url)
        meta[task.taskIdentifier] = (id: id, total: fileSize, dest: nil)
        inflight[task.taskIdentifier] = call
        responseData[task.taskIdentifier] = Data()
        call.keepAlive = true
        task.resume()
    }

    // --- download ---

    @objc func download(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"),
              let url = URL(string: urlStr),
              let destStr = call.getString("destPath") else {
            call.reject("url and destPath required"); return
        }
        let auth = call.getString("authorization") ?? ""
        let id = call.getString("id") ?? UUID().uuidString
        let dest = URL(fileURLWithPath: destStr)
        var req = URLRequest(url: url)
        if !auth.isEmpty { req.setValue(auth, forHTTPHeaderField: "Authorization") }
        let task = session.dataTask(with: req)
        meta[task.taskIdentifier] = (id: id, total: 0, dest: dest)
        inflight[task.taskIdentifier] = call
        responseData[task.taskIdentifier] = Data()
        call.keepAlive = true
        task.resume()
    }

    // --- delegate ---

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse) async -> URLSession.ResponseDisposition {
        if var m = meta[dataTask.taskIdentifier] {
            if let r = response as? HTTPURLResponse, r.expectedContentLength > 0 {
                m.total = r.expectedContentLength
                meta[dataTask.taskIdentifier] = m
            }
        }
        return .allow
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        responseData[dataTask.taskIdentifier]?.append(data)
        guard let m = meta[dataTask.taskIdentifier] else { return }
        let loaded = Int64(responseData[dataTask.taskIdentifier]?.count ?? 0)
        notifyListeners("downloadProgress", data: ["id": m.id, "loaded": loaded, "total": m.total])
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard let m = meta[task.taskIdentifier] else { return }
        notifyListeners("uploadProgress", data: ["id": m.id, "loaded": totalBytesSent, "total": totalBytesExpectedToSend])
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer {
            inflight.removeValue(forKey: task.taskIdentifier)
            meta.removeValue(forKey: task.taskIdentifier)
            responseData.removeValue(forKey: task.taskIdentifier)
        }
        guard let call = inflight[task.taskIdentifier] else { return }
        if let error = error {
            call.reject("network error: \(error.localizedDescription)"); return
        }
        let resp = task.response as? HTTPURLResponse
        let status = resp?.statusCode ?? 0
        let m = meta[task.taskIdentifier]
        if let dest = m?.dest, let data = responseData[task.taskIdentifier] {
            do {
                try data.write(to: dest, options: .atomic)
                call.resolve(["ok": status >= 200 && status < 300, "status": status, "size": data.count, "path": dest.path])
            } catch {
                call.reject("write failed: \(error.localizedDescription)")
            }
        } else {
            // upload — body in response
            let body = String(data: responseData[task.taskIdentifier] ?? Data(), encoding: .utf8) ?? ""
            call.resolve(["ok": status >= 200 && status < 300, "status": status, "body": body])
        }
    }
}
```

`.m` file: `CAP_PLUGIN(IOSTorFilePlugin, "TorFile", CAP_PLUGIN_METHOD(upload, ...); CAP_PLUGIN_METHOD(download, ...);)`.

**Step 2: Verify build**

```
cd ios/App && pod install && cd ../..
npx cap sync ios
xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Debug
```

**Step 3: Commit**

```
git add ios/App/App/IOSTorFilePlugin.swift ios/App/App/IOSTorFilePlugin.m
git commit -m "feat(ios): IOSTorFile plugin (URLSession upload/download with progress)"
```

---

### Task 2: Audit JS callers — no changes expected

**Files:**
- Audit: `src/shared/lib/file-transfer/file-transfer-service.ts`
- Audit: `src/features/messaging/model/use-file-download.ts`

**Step 1: Confirm the bridge contract is unchanged**

`registerPlugin<TorFilePlugin>('TorFile')` returns the right impl per platform. No `isIOS` branching needed in callers.

**Step 2: Add progress IDs**

If callers don't already pass an `id` on each upload/download call (so the iOS plugin can differentiate concurrent transfers in the progress event), add one. Search for `TorFile.upload(` and `TorFile.download(` and add `id: messageId`.

**Step 3: Update unit tests**

`src/shared/lib/file-transfer/file-transfer-service.test.ts` (if present) should mock `TorFile` with the unified shape — confirm it works for both Android and iOS bridges.

**Step 4: Commit if changes were necessary**

```
git add src/shared/lib/file-transfer/file-transfer-service.ts ...
git commit -m "chore(file-transfer): pass id on every TorFile call for per-task progress"
```

---

### Task 3: Background uploads (deferred)

iOS gives us `URLSessionConfiguration.background(withIdentifier:)` for transfers that survive app suspension. This is a nice-to-have for matrix media uploads >100MB. **Defer to v2** — the foreground `URLSession.default` covers the 95th-percentile case.

When we revisit, the work is:

1. Switch `session` to `URLSession(configuration: .background(withIdentifier: "com.forta.chat.transfers"), delegate: self, delegateQueue: nil)`.
2. Implement `application(_:handleEventsForBackgroundURLSession:completionHandler:)` in `AppDelegate.swift`.
3. Ensure `URLSessionDelegate.urlSessionDidFinishEvents(forBackgroundURLSession:)` calls the saved completion handler.
4. Add upload checkpointing in `file-transfer-service.ts` so we can resume on app relaunch.

Open issue: "iOS: background URLSession for large media uploads".

---

## Verification gate (end of plan)

- [ ] `npm run build` — green.
- [ ] `npx vitest run` — green.
- [ ] Real-device matrix:
  - [ ] Send a small image (< 1 MB): uploads + appears in chat.
  - [ ] Send a 30-second video: progress bar updates smoothly, completes.
  - [ ] Send a large file (50–100 MB): no OOM, completes within reasonable time.
  - [ ] Cancel mid-upload (close composer): network task cancels cleanly, no zombie.
  - [ ] Download a file: progress + completion + file opens via `@capacitor-community/file-opener`.
  - [ ] Send a file while on cellular: works, no Wi-Fi-only assumption.

## Out of scope

- Tor on iOS (per project decision).
- Background uploads beyond app suspension (deferred — v2).
- HTTP/2 / HTTP/3 tuning — `URLSession` defaults are good.

