#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Register the Swift IOSPushIntentPlugin under the JS-facing name "PushData"
// so the existing JS bridge in src/shared/lib/push/push-data-plugin.ts
// (registerPlugin<PushDataPlugin>('PushData')) addresses the same plugin on
// iOS as it does on Android.
CAP_PLUGIN(IOSPushIntentPlugin, "PushData",
    CAP_PLUGIN_METHOD(getPendingIntent, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(cacheRoomName, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(cacheRoomNames, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(cacheSenderNames, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(cancelNotification, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(replaceNotificationContent, CAPPluginReturnPromise);
)
