# iOS calls: native WebRTC instead of WebKit

Status: not started. The owner decided on 2026-10-15 to keep this as a task and not start it yet.

## Problem

On iOS the call audio and the WebRTC peer connection run inside WKWebView. WebKit owns its own audio session, and it
captures the microphone only while the page is on screen. The iPhone XR checks on 2026-10-14 showed what this costs
(`docs/manual-verification.md`, entries «iOS: «Принять» на CallKit, когда Forta свёрнута…», «iOS: звонок в громком
динамике…», «iOS: CallKit без гонки…»):

- A call answered from the background or from a cold start often sends no microphone audio. One call sent 0 bytes
  in 30 s. Another sent audio only in bursts after the user opened Forta.
- On the locked screen, Accept does not connect, and Decline reaches the caller late or not at all. JS sleeps while
  the screen is locked, and the answer waits for the microphone until the user unlocks and opens Forta.
- The call always plays on the loudspeaker. The app's `overrideOutputAudioPort` changes only the app's own session,
  so the earpiece is out of reach. The speaker toggle is hidden on iOS since 1b417f42.
- CallKit is only the ringer. The adapter releases the CallKit record before the answer, because WebKit audio under
  the CallKit session was dead (September 2026). Without a CallKit call, iOS suspends the app in the background.

Android does not have these problems: its calls use a native WebRTC proxy (`native-webrtc-bridge`, the
`RTCPeerConnection` shim) and Telecom.

## Goal

iOS calls work like Android calls: an answer from the background, the locked screen or a cold start connects with
audio both ways, the earpiece and the loudspeaker can be chosen, and CallKit owns the call for its whole life.

## Direction

1. Port the Android approach: a native `RTCPeerConnection` proxy over the WebRTC iOS SDK (a `WebRTC.xcframework` or the
   Google WebRTC pod), exposed to JS as the same plugin contract the Android shim uses, so `matrix-js-sdk` keeps its
   call logic.
2. The native side owns the audio: `RTCAudioSession` with `useManualAudio`, activated in CallKit's
   `provider(_:didActivate:)`. Then CallKit stays active for the whole call.
3. Remove the CallKit release ("audio handoff"), the release echo window (`callkit-release-echo.ts`) and the WebKit audio
   workarounds once the native path works.
4. Bring back the speaker toggle on iOS (route through `AVAudioSession` of the native session).

## Risks and open questions

- App size: the WebRTC framework adds about 20–40 MB.
- The September fixes for WebKit capture become dead code; remove them only after device checks.
- Video calls and screen sharing need native views on iOS, as on Android (`CallActivity`).
- Building and signing: Dvm Analytics team; the PLA was accepted on 2026-10-13.

## Bench

iPhone XR with `.bench/ios/` (VoIP sender `apns-voip.mjs`, caller `.bench/web/xr-call.mjs` with an audio energy probe,
`p5-run.sh`); the homeserver has no iOS push gateway. Verify: answer from background, locked screen and cold start
with audio both ways (inbound energy on the web side), earpiece and loudspeaker, five calls in a row.
