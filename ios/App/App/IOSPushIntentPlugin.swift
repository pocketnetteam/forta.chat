import Capacitor
import Foundation
import UserNotifications

/// Bridges the iOS user-notification surface to the same JS-side `PushData`
/// API that the Android `PushDataPlugin` implements. The Capacitor plugin
/// name is `"PushData"` (see `IOSPushIntentPlugin.m`) so the JS bridge in
/// `src/shared/lib/push/push-data-plugin.ts` is unchanged across platforms.
///
/// Step 4 scope (silent APNs only — NSE rendering arrives in Step 7):
///
///   * Persist room/sender display-name caches into the App Group's
///     UserDefaults so the future NSE can look them up offline.
///   * Cancel delivered notifications for a given room (used when JS notices
///     the user is already viewing the room).
///   * Provide a no-op `replaceNotificationContent` for API parity with
///     Android: once a notification is delivered on iOS, the OS does not
///     allow editing it. The NSE in Step 7 will produce the final
///     user-facing notification at delivery time, making post-decryption
///     replacement unnecessary on iOS.
///   * Surface the cold-start "tap to open" intent via `getPendingIntent()`.
///     iOS plugin observes `CapacitorLaunchOptionsRemoteNotification`
///     (posted by Capacitor's runtime when the app is cold-started by a
///     notification tap) and buffers the room/event id for the JS layer to
///     consume once the WebView is ready.
///
/// `pushOpenRoom` events for foreground and background taps are NOT emitted
/// from native — Capacitor's runtime already owns
/// `UNUserNotificationCenter.delegate` and surfaces these as the standard
/// `PushNotifications.addListener('pushNotificationActionPerformed', …)`
/// JS event. Installing a second `UNUserNotificationCenter.delegate` here
/// would silently override Capacitor's. The JS layer subscribes to that
/// Capacitor event on iOS and re-dispatches it as `push:openRoom`.
@objc(IOSPushIntentPlugin)
public class IOSPushIntentPlugin: CAPPlugin {
    /// Capacitor's name for the launch-options notification posted from
    /// `application(_:didFinishLaunchingWithOptions:)` when the app is
    /// cold-started by a remote notification tap. Matches `CAPNotifications`
    /// raw values in the Capacitor runtime.
    private static let launchNotificationName =
        Notification.Name("CapacitorLaunchOptionsRemoteNotification")

    private var pendingTap: [String: String]?

    public override func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleLaunchTap(_:)),
            name: Self.launchNotificationName,
            object: nil
        )
    }

    /// Capacitor passes the launch-options remote-notification dictionary
    /// either as the notification's `object` or under a well-known key in
    /// `userInfo`. We try both shapes — Capacitor versions disagree.
    @objc private func handleLaunchTap(_ note: Notification) {
        let payload = Self.userInfo(from: note)
        guard let payload, let roomId = payload["room_id"] as? String, !roomId.isEmpty else { return }
        pendingTap = [
            "roomId": roomId,
            "eventId": (payload["event_id"] as? String) ?? "",
        ]
    }

    private static func userInfo(from note: Notification) -> [AnyHashable: Any]? {
        if let dict = note.object as? [AnyHashable: Any] { return dict }
        if let dict = note.userInfo?["userInfo"] as? [AnyHashable: Any] { return dict }
        return note.userInfo
    }

    @objc func getPendingIntent(_ call: CAPPluginCall) {
        let p = pendingTap ?? [:]
        pendingTap = nil
        call.resolve([
            "roomId": p["roomId"] ?? "",
            "eventId": p["eventId"] ?? "",
        ])
    }

    @objc func cacheRoomName(_ call: CAPPluginCall) {
        guard
            let roomId = call.getString("roomId"),
            let name = call.getString("name")
        else { call.reject("roomId and name are required"); return }
        SharedDataStore.cacheRoomName(roomId, name)
        call.resolve()
    }

    @objc func cacheRoomNames(_ call: CAPPluginCall) {
        guard let rooms = call.getObject("rooms") as? [String: String] else {
            call.reject("rooms must be an object of roomId → name strings")
            return
        }
        SharedDataStore.cacheRoomNames(rooms)
        call.resolve()
    }

    @objc func cacheSenderNames(_ call: CAPPluginCall) {
        guard let senders = call.getObject("senders") as? [String: String] else {
            call.reject("senders must be an object of userId → name strings")
            return
        }
        SharedDataStore.cacheSenderNames(senders)
        call.resolve()
    }

    @objc func cancelNotification(_ call: CAPPluginCall) {
        guard let roomId = call.getString("roomId"), !roomId.isEmpty else {
            call.resolve()
            return
        }
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let toRemove = delivered.compactMap { n -> String? in
                guard
                    let notifRoom = n.request.content.userInfo["room_id"] as? String,
                    notifRoom == roomId
                else { return nil }
                return n.request.identifier
            }
            if !toRemove.isEmpty {
                UNUserNotificationCenter.current()
                    .removeDeliveredNotifications(withIdentifiers: toRemove)
            }
            call.resolve()
        }
    }

    /// Android-only behaviour. On iOS the Notification Service Extension
    /// (Step 7) will write the final notification at delivery time, and the
    /// OS does not let the app edit a notification once it is shown. Kept
    /// as a no-op so JS callers do not need a per-platform branch.
    @objc func replaceNotificationContent(_ call: CAPPluginCall) {
        call.resolve()
    }
}
