#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Register the Swift IOSTorFilePlugin under the JS-facing name "TorFile"
// so the JS bridge in src/shared/lib/file-transfer/file-transfer-service.ts
// (registerPlugin<TorFileNativePlugin>('TorFile')) addresses the same
// plugin on iOS as it does on Android (TorFilePlugin.kt also registers as
// "TorFile"). On iOS the plugin uses URLSession directly — no Tor — per
// the project decision recorded in 2026-05-12-ios-overall-plan.md.
//
// Both methods are CAPPluginReturnPromise: the upload/download flows
// resolve asynchronously from URLSession delegate callbacks via
// `call.keepAlive = true`.
CAP_PLUGIN(IOSTorFilePlugin, "TorFile",
    CAP_PLUGIN_METHOD(upload, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(download, CAPPluginReturnPromise);
)
