import UIKit
import Social
import MobileCoreServices
import UniformTypeIdentifiers

/// iOS Share Extension entry point.
///
/// Responsibilities:
///
///   1. Collect text / URLs / images / videos / files from the system Share
///      Sheet's `extensionContext.inputItems`.
///   2. Copy file-shaped attachments into the shared App Group container so
///      the host app can still read them after this extension process is
///      torn down (the original `NSItemProvider` URLs are sandboxed to the
///      extension's process).
///   3. Persist a dictionary at `share-target-data` in the App Group's
///      `UserDefaults` matching the schema the `@capgo/capacitor-share-target`
///      iOS plugin expects:
///        ```
///        {
///          "title":  String,
///          "texts":  [String],
///          "files":  [{ "uri": String, "name": String, "mimeType": String }],
///        }
///        ```
///      The plugin (in the host app's process) re-reads this on `load()`,
///      on `capacitorOpenURL` (i.e., when the host app receives our
///      `forta://share` URL), and on every `didBecomeActive`. It emits
///      `shareReceived` to JavaScript with `retainUntilConsumed: true` so
///      late-registered JS listeners still receive the payload.
///   4. Open the host app via `forta://share`. Triggering this URL while
///      the extension is in the foreground forces iOS to switch back to
///      Forta Chat, which in turn fires `application(_:open:options:)` →
///      Capacitor's `capacitorOpenURL` notification → the plugin's
///      `checkForSharedContent()` flush.
///
/// Apple constraints worth noting:
///
///   * `extensionContext?.completeRequest` MUST be called exactly once,
///     otherwise the system shows a spinner forever.
///   * `UIApplication.shared` is unavailable in extensions; we walk the
///     responder chain to find a `UIApplication` and call `openURL:` via
///     `perform(_:with:)`. This is the standard workaround.
///   * Memory budget for share extensions is low (~120 MB); copying a
///     >100 MB video is fine but we intentionally stream via `FileManager`
///     instead of loading into memory.
@objc(ShareViewController)
class ShareViewController: SLComposeServiceViewController {
    private let appGroupId = "group.com.forta.chat"
    private let storeKey = "share-target-data"
    private let appUrlScheme = "forta://share"
    private let containerSubdir = "share-inbox"

    override func isContentValid() -> Bool { true }

    override func didSelectPost() {
        let typedText = (contentText as String?) ?? ""
        let providers = collectAttachmentProviders()

        Task { [weak self] in
            guard let self else { return }
            let collected = await self.readAllAttachments(providers)
            self.persistPayload(text: typedText, items: collected)
            await MainActor.run {
                self.openHostApp()
                self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            }
        }
    }

    override func configurationItems() -> [Any]! { [] }

    // MARK: - Attachment collection

    private func collectAttachmentProviders() -> [NSItemProvider] {
        guard let inputItems = extensionContext?.inputItems as? [NSExtensionItem] else { return [] }
        var providers: [NSItemProvider] = []
        for item in inputItems {
            if let attachments = item.attachments {
                providers.append(contentsOf: attachments)
            }
        }
        return providers
    }

    private struct CollectedItem {
        var fileUri: String?
        var mimeType: String?
        var name: String?
        var url: String?
        var text: String?
    }

    private func readAllAttachments(_ providers: [NSItemProvider]) async -> [CollectedItem] {
        await withTaskGroup(of: CollectedItem?.self) { group in
            for provider in providers {
                group.addTask { [weak self] in
                    await self?.readAttachment(provider)
                }
            }
            var out: [CollectedItem] = []
            for await result in group {
                if let item = result { out.append(item) }
            }
            return out
        }
    }

    /// Resolve a single `NSItemProvider` in priority order:
    ///   file URL → image data → movie URL → URL → plain text.
    /// Returns `nil` when the provider yielded nothing usable.
    private func readAttachment(_ provider: NSItemProvider) async -> CollectedItem? {
        let fileTypes: [String] = [
            UTType.fileURL.identifier,
            UTType.movie.identifier,
            UTType.image.identifier,
            UTType.pdf.identifier,
            UTType.audio.identifier,
            UTType.data.identifier,
        ]

        for typeId in fileTypes where provider.hasItemConformingToTypeIdentifier(typeId) {
            if let item = await loadFileItem(provider: provider, typeIdentifier: typeId) {
                return item
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let urlString = await loadString(provider: provider, typeIdentifier: UTType.url.identifier) {
                return CollectedItem(url: urlString)
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = await loadString(provider: provider, typeIdentifier: UTType.plainText.identifier) {
                return CollectedItem(text: text)
            }
        }

        return nil
    }

    private func loadFileItem(provider: NSItemProvider, typeIdentifier: String) async -> CollectedItem? {
        let raw: NSSecureCoding? = await withCheckedContinuation { cont in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { value, _ in
                cont.resume(returning: value)
            }
        }
        guard let raw else { return nil }

        if let url = raw as? URL {
            return copyURLToContainer(url, suggestedName: provider.suggestedName)
        }
        if let data = raw as? Data {
            let ext = preferredExtension(for: typeIdentifier) ?? "bin"
            let baseName = provider.suggestedName ?? "share_\(Int(Date().timeIntervalSince1970))"
            let name = baseName.contains(".") ? baseName : "\(baseName).\(ext)"
            return writeDataToContainer(data, name: name, mimeType: mimeType(for: typeIdentifier))
        }
        if let image = raw as? UIImage, let data = image.jpegData(compressionQuality: 0.95) {
            let name = (provider.suggestedName ?? "share_\(Int(Date().timeIntervalSince1970))") + ".jpg"
            return writeDataToContainer(data, name: name, mimeType: "image/jpeg")
        }
        return nil
    }

    private func loadString(provider: NSItemProvider, typeIdentifier: String) async -> String? {
        let raw: NSSecureCoding? = await withCheckedContinuation { cont in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { value, _ in
                cont.resume(returning: value)
            }
        }
        if let url = raw as? URL { return url.absoluteString }
        if let str = raw as? String { return str }
        if let data = raw as? Data, let str = String(data: data, encoding: .utf8) { return str }
        return nil
    }

    // MARK: - File copy into App Group container

    /// Copy `src` into the App Group's `share-inbox/` so the host app can
    /// read it after this extension process exits. Returns the absolute
    /// path of the copied file (NOT a `file://` URL — JavaScript will read
    /// it via `Capacitor.Filesystem.readFile`).
    private func copyURLToContainer(_ src: URL, suggestedName: String?) -> CollectedItem? {
        guard let dstDir = ensureContainerDir() else { return nil }
        let baseName = suggestedName ?? src.lastPathComponent
        let safeName = sanitize(baseName.isEmpty ? src.lastPathComponent : baseName)
        let dst = dstDir.appendingPathComponent(uniqueName(in: dstDir, base: safeName))

        do {
            // Some providers hand us a security-scoped URL.
            let needsScope = src.startAccessingSecurityScopedResource()
            defer { if needsScope { src.stopAccessingSecurityScopedResource() } }

            if FileManager.default.fileExists(atPath: dst.path) {
                try FileManager.default.removeItem(at: dst)
            }
            try FileManager.default.copyItem(at: src, to: dst)
        } catch {
            NSLog("[ShareExtension] copy failed: \(error.localizedDescription)")
            return nil
        }

        let mime = mimeType(forFileExtension: dst.pathExtension) ?? "application/octet-stream"
        return CollectedItem(fileUri: dst.path, mimeType: mime, name: dst.lastPathComponent)
    }

    private func writeDataToContainer(_ data: Data, name: String, mimeType: String?) -> CollectedItem? {
        guard let dstDir = ensureContainerDir() else { return nil }
        let safeName = sanitize(name)
        let dst = dstDir.appendingPathComponent(uniqueName(in: dstDir, base: safeName))
        do {
            try data.write(to: dst, options: .atomic)
        } catch {
            NSLog("[ShareExtension] write failed: \(error.localizedDescription)")
            return nil
        }
        return CollectedItem(
            fileUri: dst.path,
            mimeType: mimeType ?? self.mimeType(forFileExtension: dst.pathExtension) ?? "application/octet-stream",
            name: dst.lastPathComponent
        )
    }

    private func ensureContainerDir() -> URL? {
        guard let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else { return nil }
        let dir = container.appendingPathComponent(containerSubdir, isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            } catch {
                NSLog("[ShareExtension] mkdir failed: \(error.localizedDescription)")
                return nil
            }
        }
        return dir
    }

    private func sanitize(_ name: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|")
        let scrubbed = name.components(separatedBy: bad).joined(separator: "_")
        return scrubbed.isEmpty ? "share_file" : scrubbed
    }

    private func uniqueName(in dir: URL, base: String) -> String {
        let candidate = dir.appendingPathComponent(base)
        if !FileManager.default.fileExists(atPath: candidate.path) { return base }
        let stem = (base as NSString).deletingPathExtension
        let ext = (base as NSString).pathExtension
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        return ext.isEmpty ? "\(stem)_\(stamp)" : "\(stem)_\(stamp).\(ext)"
    }

    // MARK: - UTI / extension helpers

    private func preferredExtension(for typeIdentifier: String) -> String? {
        UTType(typeIdentifier)?.preferredFilenameExtension
    }

    private func mimeType(for typeIdentifier: String) -> String? {
        UTType(typeIdentifier)?.preferredMIMEType
    }

    private func mimeType(forFileExtension ext: String) -> String? {
        guard !ext.isEmpty else { return nil }
        return UTType(filenameExtension: ext)?.preferredMIMEType
    }

    // MARK: - Persistence + host launch

    private func persistPayload(text: String, items: [CollectedItem]) {
        guard let defaults = UserDefaults(suiteName: appGroupId) else {
            NSLog("[ShareExtension] no app group defaults for \(appGroupId)")
            return
        }

        var texts: [String] = []
        if !text.isEmpty { texts.append(text) }

        var files: [[String: Any]] = []
        for item in items {
            if let fileUri = item.fileUri {
                var entry: [String: Any] = ["uri": fileUri]
                if let mime = item.mimeType { entry["mimeType"] = mime }
                if let name = item.name { entry["name"] = name }
                files.append(entry)
                continue
            }
            if let url = item.url, !url.isEmpty {
                texts.append(url)
                continue
            }
            if let str = item.text, !str.isEmpty {
                texts.append(str)
            }
        }

        let payload: [String: Any] = [
            "title": "",
            "texts": texts,
            "files": files,
        ]

        defaults.set(payload, forKey: storeKey)
        defaults.synchronize()
    }

    private func openHostApp() {
        guard let url = URL(string: appUrlScheme) else { return }
        var responder: UIResponder? = self
        while let next = responder {
            if let app = next as? UIApplication {
                app.perform(NSSelectorFromString("openURL:"), with: url)
                return
            }
            responder = next.next
        }
    }
}
