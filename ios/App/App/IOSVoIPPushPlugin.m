#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Register the Swift IOSVoIPPushPlugin under the JS-facing name "IOSVoIPPush"
// so the bridge in src/shared/lib/push/ios-voip-push.ts addresses it via
// registerPlugin<IOSVoIPPushPlugin>('IOSVoIPPush'). PushKit registration
// itself runs in `IOSVoIPPushPlugin.load()` — getToken is only used for
// JS-driven retrieval; the initial value is delivered via the
// `voipTokenReceived` event.
CAP_PLUGIN(IOSVoIPPushPlugin, "IOSVoIPPush",
    CAP_PLUGIN_METHOD(getToken, CAPPluginReturnPromise);
)
