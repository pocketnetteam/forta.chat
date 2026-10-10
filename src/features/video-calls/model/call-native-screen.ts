/** The single entry point that raises the Android native call screen (split out of call-service.ts). */
import { isAndroid } from "@/shared/lib/platform";
import { NativeWebRTC } from "@/shared/lib/native-webrtc";
import { finalizeCall } from "./finalize-call";
import { holdPageAwake } from "./page-awake-tone";

/**
 * Every native call screen goes up through here. The screen covers the page,
 * and Chromium freezes a hidden page that stays silent for a minute; a frozen
 * page never hears the peer hang up (see page-awake-tone.ts). finalizeCall
 * releases the hold. Android only: the freeze is Chromium's, and iOS has no
 * NativeWebRTC call screen to cover the page.
 */
export function launchNativeCallScreen(options: Parameters<typeof NativeWebRTC.launchCallUI>[0]): Promise<void> {
  // iOS has no NativeWebRTC plugin: the call rejected with UNIMPLEMENTED on
  // every call. CallKit is its call screen.
  if (!isAndroid) return Promise.resolve();
  holdPageAwake(options.callId);
  return NativeWebRTC.launchCallUI(options);
}
