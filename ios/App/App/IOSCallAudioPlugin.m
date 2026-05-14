#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Register the Swift IOSCallAudioPlugin under the JS-facing name
// "IOSCallAudio" so the iOS adapter in src/shared/lib/native-calls/
// native-call-bridge.ios.ts addresses it via
// registerPlugin<IOSCallAudioPlugin>('IOSCallAudio').
//
// All methods are CAPPluginReturnPromise — even the synchronous-looking
// ones — because Capacitor's bridge always serializes through the
// JS↔native message queue, and Promise resolution is the only way to
// surface errors with a stack on the JS side.
CAP_PLUGIN(IOSCallAudioPlugin, "IOSCallAudio",
    CAP_PLUGIN_METHOD(requestRecordPermission, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(probeAvailability, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(start, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stop, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(forceStop, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getStatus, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(setOutput, CAPPluginReturnPromise);
)
