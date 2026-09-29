import Capacitor
import Foundation

/// JS surface for VoIP pushes: the token and the push events.
///
/// The `PKPushRegistry` itself and the CallKit report live in
/// `VoIPPushCoordinator`, created at app launch — a VoIP push must be
/// reported to CallKit in the same run-loop turn as its delivery, which on a
/// cold start happens before this plugin (or the WebView) exists. This plugin
/// only registers itself with the coordinator on load, so the coordinator can
/// deliver `voipTokenReceived` / `voipTokenInvalidated` / `voipPushReceived`
/// to JS; events raised before load are queued there and flushed on load.
///
/// JS (`push-service.ts`) registers a second Matrix pusher with
/// `app_id: 'fortaios.voip'` from the token; the CallKit accept/decline
/// events reach JS through `@capgo/capacitor-incoming-call-kit`'s listeners
/// and `native-call-bridge.ios.ts`.
@objc(IOSVoIPPushPlugin)
public class IOSVoIPPushPlugin: CAPPlugin {
    public override func load() {
        VoIPPushCoordinator.shared.plugin = self
    }

    /// Current VoIP token, or `{ token: null }` until iOS has issued one — JS
    /// also subscribes to `voipTokenReceived` for the first issue and rotations.
    @objc func getToken(_ call: CAPPluginCall) {
        if let token = VoIPPushCoordinator.shared.tokenHex {
            call.resolve(["token": token])
        } else {
            call.resolve(["token": NSNull()])
        }
    }
}
