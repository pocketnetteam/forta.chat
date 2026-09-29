import Foundation
import PushKit
import CallKit
import Capacitor
import IncomingCallKitPlugin

/// The account state JS last reported, kept where a PushKit launch can read it
/// before the WebView exists. Mirrors Android's `PushSessionPolicy`.
///
/// Logout deletes this device's pushers on the homeserver, but that needs the
/// network: a logout made offline leaves the VoIP pusher behind, and every call
/// to the old account would ring here. A VoIP push cannot simply be ignored —
/// iOS kills the app and stops delivering VoIP pushes unless each one is
/// reported to CallKit — so a signed-out device reports it and ends it at once.
/// No state at all is an install whose JS has not reported since the update:
/// signed in as far as anyone knows.
enum PushSession {
    static let active = "active"
    static let loggedOut = "logged_out"
    private static let key = "forta.push.session"

    static var state: String? { UserDefaults.standard.string(forKey: key) }

    static func write(_ state: String) {
        UserDefaults.standard.set(state, forKey: key)
    }

    static func shouldRing(_ state: String?) -> Bool { state != loggedOut }
}

/// The "Incoming calls" switch JS last reported (forta-bugs#1388). Off, a VoIP
/// push is reported and ended at once like a signed-out one, so Bastyon and
/// the account's other devices keep ringing. No value yet: calls ring.
enum IncomingCallsSetting {
    private static let key = "forta.calls.incoming_enabled"

    static var isEnabled: Bool { UserDefaults.standard.object(forKey: key) as? Bool ?? true }

    static func write(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: key)
    }
}

/// Reports a VoIP push that must not ring (signed out, or incoming calls off)
/// and ends the call in the same breath. Its own provider, so the app's call
/// provider (the CallKit plugin) never sees the call; kept out of Recents.
final class SignedOutCallSink: NSObject, CXProviderDelegate {
    private lazy var provider: CXProvider = {
        let config = CXProviderConfiguration()
        config.includesCallsInRecents = false
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        let provider = CXProvider(configuration: config)
        provider.setDelegate(self, queue: .main)
        return provider
    }()

    func reportAndEnd(callId: String, reason: String) {
        let uuid = UUID()
        let update = CXCallUpdate()
        update.localizedCallerName = "Forta"
        update.hasVideo = false
        provider.reportNewIncomingCall(with: uuid, update: update) { [provider] error in
            if let error {
                NSLog("[VoIPPush] %@: CallKit rejected call %@: %@", reason, callId, error.localizedDescription)
                return
            }
            provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
            NSLog("[VoIPPush] %@: ended call %@", reason, callId)
        }
    }

    func providerDidReset(_ provider: CXProvider) {}
}

/// Owns the app's `PKPushRegistry` from `application(_:didFinishLaunchingWithOptions:)`
/// and reports every VoIP push to CallKit itself, synchronously.
///
/// Why not the Capacitor plugin: iOS launches the app for a VoIP push and
/// terminates it ("Killing app because it never posted an incoming call")
/// unless `reportNewIncomingCall` runs in the same run-loop turn as
/// `pushRegistry(_:didReceiveIncomingPushWith:for:completion:)`. On a cold
/// start that turn comes before the WebView, the Capacitor bridge or any
/// plugin call can be relied on — the report through the plugin's Capacitor
/// method never reached callservicesd on the iPhone XR (2026-09-24), and two
/// such terminations made iOS drop VoIP launches for the app altogether. So
/// the registry lives here, created at launch, and the report goes straight
/// to the CallKit provider through the forked plugin's public
/// `reportIncomingCall` (tag 8.2.1-forta.2), inline on the main queue.
///
/// `IOSVoIPPushPlugin` stays the JS surface: it registers itself here on
/// load and receives the token and push events for `notifyListeners`; events
/// that arrive before the plugin exists are queued and delivered on load.
final class VoIPPushCoordinator: NSObject, PKPushRegistryDelegate {
    static let shared = VoIPPushCoordinator()

    private var registry: PKPushRegistry?
    /// Hex VoIP token, or nil until iOS issued one (or after invalidation).
    private(set) var tokenHex: String?
    private var pendingEvents: [(name: String, data: [String: Any])] = []
    private let signedOutSink = SignedOutCallSink()

    /// Set by `IOSVoIPPushPlugin.load()`; queued events flush on assignment.
    weak var plugin: CAPPlugin? {
        didSet { flushPendingEvents() }
    }

    /// Idempotent; called from the app delegate at launch.
    func start() {
        guard registry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
    }

    // MARK: - PKPushRegistryDelegate

    func pushRegistry(
        _ registry: PKPushRegistry,
        didUpdate pushCredentials: PKPushCredentials,
        for type: PKPushType
    ) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        tokenHex = token
        emit("voipTokenReceived", ["token": token])
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        tokenHex = nil
        emit("voipTokenInvalidated", [:])
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else {
            completion()
            return
        }
        let dict = payload.dictionaryPayload
        let callId = (dict["call_id"] as? String)
            ?? (dict["event_id"] as? String)
            ?? UUID().uuidString
        let callerName = (dict["sender_display_name"] as? String) ?? "Unknown"
        let roomId = (dict["room_id"] as? String) ?? ""
        // Sygnal puts the Matrix event type in `msg_type`; the `.video` suffix
        // marks a video call (see docs/plans/ios/SYGNAL-CONFIG-REQUEST.md).
        let hasVideo = (dict["msg_type"] as? String) == "m.call.invite.video"
        // NSLog, not CAPLog: on a push launch there is no attached console and
        // the system log is the only place these lines can be read.
        NSLog("[VoIPPush] push received for call %@ (room %@)", callId, roomId)

        guard PushSession.shouldRing(PushSession.state) else {
            // Synchronous report, as below; nothing reaches JS or the app's provider.
            signedOutSink.reportAndEnd(callId: callId, reason: "signed out")
            completion()
            return
        }
        guard IncomingCallsSetting.isEnabled else {
            signedOutSink.reportAndEnd(callId: callId, reason: "incoming calls off")
            completion()
            return
        }

        // Synchronous on the main queue (the registry's queue): the provider is
        // told before this method returns and before completion().
        IncomingCallKit.shared.reportIncomingCall(
            callId: callId,
            callerName: callerName,
            handle: roomId.isEmpty ? nil : roomId,
            hasVideo: hasVideo,
            extra: ["roomId": roomId]
        ) { error in
            if let error {
                NSLog("[VoIPPush] CallKit rejected call %@: %@", callId, error.localizedDescription)
            } else {
                NSLog("[VoIPPush] CallKit displayed call %@", callId)
            }
        }
        NSLog("[VoIPPush] reported call %@ to CallKit", callId)

        // Telemetry / pre-warming for JS; queued when the bridge is not up yet.
        emit("voipPushReceived", [
            "callId": callId,
            "roomId": roomId,
            "callerName": callerName,
            "hasVideo": hasVideo,
        ])
        completion()
    }

    // MARK: - JS events

    private func emit(_ name: String, _ data: [String: Any]) {
        guard let plugin else {
            pendingEvents.append((name, data))
            return
        }
        plugin.notifyListeners(name, data: data, retainUntilConsumed: true)
    }

    private func flushPendingEvents() {
        guard let plugin else { return }
        let events = pendingEvents
        pendingEvents.removeAll()
        for event in events {
            plugin.notifyListeners(event.name, data: event.data, retainUntilConsumed: true)
        }
    }
}
