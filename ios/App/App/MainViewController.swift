import Capacitor
import UIKit

/// Root controller of `Main.storyboard`.
///
/// Capacitor 8 registers only the plugin classes `cap sync` writes into
/// `capacitor.config.json` (`packageClassList`), which is derived from the npm
/// packages in `node_modules`. The plugins that live in this app target are
/// not on that list, and the `CAP_PLUGIN` macro in their `.m` files only
/// provides the `CAPBridgedPlugin` conformance — it no longer registers
/// anything by itself. Until this override existed every call from JS to
/// `IOSCallAudio`, `IOSVoIPPush`, `PushData` and `TorFile` came back
/// `UNIMPLEMENTED`: the microphone was never requested, so an accepted
/// CallKit call was rejected at once, and no VoIP token ever reached JS.
///
/// `registerPluginType` is a no-op while `autoRegisterPlugins` is on (the
/// default), so the instances are registered directly. `capacitorDidLoad`
/// runs before the WebView loads the app, so JS never sees the plugins absent.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(IOSCallAudioPlugin())
        bridge?.registerPluginInstance(IOSVoIPPushPlugin())
        bridge?.registerPluginInstance(IOSPushIntentPlugin())
        bridge?.registerPluginInstance(IOSTorFilePlugin())
    }
}
