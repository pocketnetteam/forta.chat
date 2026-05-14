import UserNotifications

/// Notification Service Extension entry point.
///
/// Sygnal delivers regular APNs alerts with `mutable-content: 1` for the
/// `fortaios` pusher (see `docs/plans/ios/SYGNAL-CONFIG-REQUEST.md`). When
/// that flag is set, the OS instantiates *this* class in a separate process
/// before showing the notification, gives us up to ~30s to mutate the
/// content, then displays whatever we hand to `contentHandler`.
///
/// What this extension does (v1):
///
///   1. Renders a human-readable `title` / `subtitle` / `body` for
///      `m.room.message` pushes using the offline name cache stored in the
///      shared App Group (`SharedDataStore`), falling back to whatever the
///      server-provided `room_name` / `sender_display_name` keys carry.
///   2. Caches `room_name` and `sender_display_name` from each delivery so
///      future pushes can be rendered even when those fields are absent
///      (Sygnal occasionally omits them on retry).
///   3. Suppresses follow-up `m.call.hangup` / `m.call.reject` /
///      `m.call.select_answer` notifications and best-effort removes any
///      prior incoming-call notification keyed by `call_id`.
///   4. Sets `threadIdentifier` to `room_id` so iOS groups notifications
///      from the same room — purely a UX nicety, costs nothing here.
///
/// What this extension does NOT do (deferred to a v2 ticket, see
/// `docs/plans/ios/2026-05-14-nse-e2e-decrypt-issue.md`):
///
///   * Decrypt E2E room bodies. For encrypted rooms Sygnal will not send a
///     `content_body` and we currently render the localized "New message"
///     placeholder. v2 will port enough of the Olm session store into
///     Swift (or expose it via the App Group from the main app) to decrypt
///     in-process here.
///
/// Apple constraints we care about:
///
///   * `didReceive` must always invoke `contentHandler` — even on failure —
///     or the OS keeps the notification queued until timeout, then shows
///     the original undecorated payload.
///   * `serviceExtensionTimeWillExpire()` is our last-chance callback when
///     the OS is about to give up on us. We hand back whatever we have so
///     the user still sees *something*.
///   * Memory limit for this process is small (~24MB). Keep dependencies
///     out unless absolutely necessary. Only `Foundation` +
///     `UserNotifications` here, plus the in-target copy of
///     `SharedDataStore`.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        self.bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let content = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        let userInfo = content.userInfo
        let msgType = (userInfo["msg_type"] as? String) ?? ""
        let providedRoomName = userInfo["room_name"] as? String
        let providedSenderName = userInfo["sender_display_name"] as? String
        let senderId = userInfo["sender"] as? String
        let roomId = userInfo["room_id"] as? String

        // Cache server-provided names for offline lookups on future deliveries.
        // We do this BEFORE the cancel-path so even hangup pushes refresh the
        // cache if the server happens to populate names.
        if let roomId, let providedRoomName, !providedRoomName.isEmpty {
            SharedDataStore.cacheRoomName(roomId, providedRoomName)
        }
        if let senderId, let providedSenderName, !providedSenderName.isEmpty {
            SharedDataStore.cacheSenderName(senderId, providedSenderName)
        }

        // Cancel path — suppress hangup/reject/select_answer notifications and
        // try to remove any matching prior `m.call.invite` notification from
        // the tray.
        if NotificationService.isCallCancelEvent(msgType) {
            if let callId = userInfo["call_id"] as? String, !callId.isEmpty {
                UNUserNotificationCenter.current()
                    .removeDeliveredNotifications(withIdentifiers: [callId])
            }
            // Empty content suppresses the alert UI; the user will not see a
            // new banner for the hangup itself.
            contentHandler(UNMutableNotificationContent())
            return
        }

        // Title / subtitle / body for normal `m.room.message` (and any other
        // event type that falls through to here). Falls back to whatever the
        // server populated when caches are empty.
        if let roomId {
            content.title = SharedDataStore.roomName(roomId)
                ?? providedRoomName
                ?? content.title
            content.threadIdentifier = roomId
        }

        if let resolved = NotificationService.resolveSenderName(
            providedSenderName: providedSenderName,
            senderId: senderId
        ) {
            content.subtitle = resolved
        }

        let plaintextBody = userInfo["content_body"] as? String
        let contentMsgtype = (userInfo["content_msgtype"] as? String) ?? "m.text"
        content.body = NotificationService.renderBody(
            msgtype: contentMsgtype,
            plaintext: plaintextBody
        )

        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        // Last-chance fallback: hand back whatever we built so the user still
        // sees the partially-rendered notification rather than the raw
        // server payload.
        if let handler = contentHandler, let content = bestAttemptContent {
            handler(content)
        }
    }

    // MARK: - Pure helpers (exposed for unit testing)

    static func isCallCancelEvent(_ msgType: String) -> Bool {
        switch msgType {
        case "m.call.hangup", "m.call.reject", "m.call.select_answer":
            return true
        default:
            return false
        }
    }

    static func resolveSenderName(
        providedSenderName: String?,
        senderId: String?
    ) -> String? {
        if let n = providedSenderName, !n.isEmpty { return n }
        if let id = senderId, let cached = SharedDataStore.senderName(id), !cached.isEmpty {
            return cached
        }
        return senderId
    }

    /// Map a Matrix `m.room.message` content msgtype to a user-facing body.
    /// For text events we hand back the server-supplied plaintext when
    /// available; encrypted rooms (no `content_body`) collapse to the
    /// localized "New message" placeholder.
    static func renderBody(msgtype: String, plaintext: String?) -> String {
        switch msgtype {
        case "m.image":
            return NSLocalizedString("push.body.photo", value: "Photo", comment: "Push body for image messages")
        case "m.video":
            return NSLocalizedString("push.body.video", value: "Video", comment: "Push body for video messages")
        case "m.audio":
            return NSLocalizedString("push.body.voice", value: "Voice message", comment: "Push body for audio messages")
        case "m.file":
            return NSLocalizedString("push.body.file", value: "File", comment: "Push body for file messages")
        default:
            if let body = plaintext, !body.isEmpty {
                return body
            }
            return NSLocalizedString("push.body.placeholder", value: "New message", comment: "Push body fallback when plaintext is unavailable (e.g. E2E rooms)")
        }
    }
}
