import Foundation

/// Shared key/value store backed by the App Group's `UserDefaults`. The same
/// suite is read/written by the main app, the (future) Notification Service
/// Extension, and the (future) Share Extension targets, which is how name
/// caches stay consistent across processes.
///
/// Schema (string-typed for easy bridging to JS):
///   - `roomNames`:   `[roomId: String]   -> displayName: String`
///   - `senderNames`: `[userId: String]   -> displayName: String`
///
/// All writes are performed atomically against a snapshot of the dictionary
/// to avoid losing concurrent updates from the main app and the NSE.
public enum SharedDataStore {
    public static let appGroup = "group.com.forta.chat"

    private static let roomNamesKey = "roomNames"
    private static let senderNamesKey = "senderNames"

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    // MARK: - Room names

    public static func cacheRoomName(_ roomId: String, _ name: String) {
        guard let defaults else { return }
        var dict = (defaults.dictionary(forKey: roomNamesKey) as? [String: String]) ?? [:]
        dict[roomId] = name
        defaults.set(dict, forKey: roomNamesKey)
    }

    public static func cacheRoomNames(_ rooms: [String: String]) {
        guard let defaults, !rooms.isEmpty else { return }
        var dict = (defaults.dictionary(forKey: roomNamesKey) as? [String: String]) ?? [:]
        for (id, name) in rooms { dict[id] = name }
        defaults.set(dict, forKey: roomNamesKey)
    }

    public static func roomName(_ roomId: String) -> String? {
        (defaults?.dictionary(forKey: roomNamesKey) as? [String: String])?[roomId]
    }

    // MARK: - Sender names

    public static func cacheSenderName(_ userId: String, _ name: String) {
        guard let defaults else { return }
        var dict = (defaults.dictionary(forKey: senderNamesKey) as? [String: String]) ?? [:]
        dict[userId] = name
        defaults.set(dict, forKey: senderNamesKey)
    }

    public static func cacheSenderNames(_ senders: [String: String]) {
        guard let defaults, !senders.isEmpty else { return }
        var dict = (defaults.dictionary(forKey: senderNamesKey) as? [String: String]) ?? [:]
        for (id, name) in senders { dict[id] = name }
        defaults.set(dict, forKey: senderNamesKey)
    }

    public static func senderName(_ userId: String) -> String? {
        (defaults?.dictionary(forKey: senderNamesKey) as? [String: String])?[userId]
    }
}
