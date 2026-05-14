import Capacitor
import Foundation
import AVFoundation

/// AVAudioSession lifecycle for VoIP calls. Owns the
/// `.playAndRecord / .voiceChat (or .videoChat)` category that keeps
/// audio alive when the app is backgrounded mid-call — without this the
/// WKWebView WebRTC stack drops microphone capture within ~1s of
/// backgrounding (confirmed on iPhone 12 / iOS 17 during Step 5 smoke
/// test).
///
/// CallKit + AVAudioSession integration:
///
///   * The CallKit ringer (in @capgo/capacitor-incoming-call-kit) calls
///     `CXProvider.reportNewIncomingCall(...)`. When the user accepts,
///     CXAnswerCallAction fires; the JS adapter unwraps that as
///     `callAccepted` → `call-service.answerCall()` → SDK answer →
///     `nativeCallBridge.startAudioRouting({callType})` → us.
///   * On hangup / timeout: `nativeCallBridge.stopAudioRouting()` →
///     `IOSCallAudio.stop()` → `setActive(false, [.notifyOthersOnDeactivation])`.
///   * `forceStop()` (Android-watchdog parity) is the same as `stop()` on
///     iOS — there is no equivalent of Android's stuck-MODE_IN_COMMUNICATION
///     situation here, but we expose the method so the watchdog can call it.
///
/// Modes:
///   - voice → AVAudioSession.Mode.voiceChat   (mono, narrowband-friendly,
///                                              forces voice processing —
///                                              echo cancellation + noise
///                                              suppression on by default)
///   - video → AVAudioSession.Mode.videoChat   (stereo-friendly, looser
///                                              voice processing tuning,
///                                              still .playAndRecord)
///
/// Options:
///   - .allowBluetooth + .allowBluetoothA2DP — accept BT headsets as
///     input/output. Without these the user has no way to switch to AirPods.
///   - .defaultToSpeaker — voice calls without a headset go to the loud
///     speaker instead of the earpiece, matching Android's defaults.
///
/// Step 6 Task 6 will add AVAudioSession interruption handling
/// (`AVAudioSession.interruptionNotification`) on top of this plugin.
@objc(IOSCallAudioPlugin)
public class IOSCallAudioPlugin: CAPPlugin {

    // MARK: - Lifecycle

    /// Subscribe to AVAudioSession interruption events. iOS posts these
    /// when the OS takes the audio session away from us — most commonly
    /// when a real cellular phone call comes in mid-VoIP-call. We
    /// surface them to JS via `audioInterruptionBegan` /
    /// `audioInterruptionEnded` so the JS watchdog (audio-watchdog.ts)
    /// can hang up our call and let CallKit + the system phone UI take
    /// over cleanly.
    ///
    /// Other triggers iOS routes through this notification:
    ///   - Siri activated mid-call (rare but real)
    ///   - Music app force-takeover (with `.notifyOthersOnDeactivation`
    ///     options, normally we cooperate; this is the catch-all)
    ///   - System alarm / timer firing in the foreground
    public override func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioSessionInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func handleAudioSessionInterruption(_ notification: Notification) {
        guard
            let info = notification.userInfo,
            let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else { return }

        switch type {
        case .began:
            notifyListeners("audioInterruptionBegan", data: [:])
        case .ended:
            // The .ended payload includes the interruption options,
            // most importantly `.shouldResume`. Forward it so JS can
            // decide whether to attempt a re-activate or stay silent.
            var data: [String: Any] = [:]
            if let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                data["shouldResume"] = options.contains(.shouldResume)
            }
            notifyListeners("audioInterruptionEnded", data: data)
        @unknown default:
            break
        }
    }

    // MARK: - Permissions

    /// Wraps `AVAudioSession.requestRecordPermission` so the JS layer
    /// can drive the iOS mic prompt with the same `{granted: boolean}`
    /// shape Android emits from `NativeCall.requestAudioPermission`.
    @objc func requestRecordPermission(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            call.resolve(["granted": granted])
        }
    }

    /// Lightweight equivalent of Android's `probeAudioAvailability`.
    /// iOS does not have the equivalent OEM mic-locking landmines
    /// (MIUI privacy shield, Xiaomi/Huawei ghost permissions, etc.),
    /// so we just check `recordPermission` and report `available: true`
    /// when granted. The bridge already has an optimistic fallback when
    /// the underlying plugin throws — this method is intentionally never
    /// the gate that blocks call setup; that responsibility lives in
    /// the SDK's getUserMedia path.
    @objc func probeAvailability(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        let granted = session.recordPermission == .granted
        call.resolve([
            "available": granted,
            "hasInput": granted,
            "canInit": granted,
            "conflicting": [String](),
        ])
    }

    // MARK: - Audio session lifecycle

    @objc func start(_ call: CAPPluginCall) {
        let isVideo = call.getString("callType") == "video"
        let session = AVAudioSession.sharedInstance()

        // Build the option set explicitly so the compiler catches typos
        // and the diff is readable. Order does not matter; iOS unions
        // the bits internally.
        let options: AVAudioSession.CategoryOptions = [
            .allowBluetooth,
            .allowBluetoothA2DP,
            .defaultToSpeaker,
        ]
        let mode: AVAudioSession.Mode = isVideo ? .videoChat : .voiceChat

        do {
            try session.setCategory(.playAndRecord, mode: mode, options: options)
            try session.setActive(true, options: [.notifyOthersOnDeactivation])
            call.resolve()
        } catch {
            // Surface as a plugin error so the bridge can downgrade to
            // best-effort (call-service swallows the rejection — audio
            // routing failure must not block the call from connecting,
            // matching Android's `startAudioRouting failed` policy).
            call.reject("AVAudioSession.start failed: \(error.localizedDescription)", nil, error)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        deactivate(reason: "stop")
        call.resolve()
    }

    /// Brute-force teardown. Same implementation as `stop()` on iOS:
    /// AVAudioSession does not have a "stuck VoIP mode" failure analogue
    /// the way Android does (the OEM-specific MODE_IN_COMMUNICATION
    /// reset). The method exists for cross-platform parity so the
    /// audio-watchdog can call `nativeCallBridge.forceStopAudio()`
    /// without an `if (isAndroid)` branch.
    @objc func forceStop(_ call: CAPPluginCall) {
        deactivate(reason: "forceStop")
        call.resolve()
    }

    private func deactivate(reason: String) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            // Best-effort. Errors here are common and harmless (e.g. the
            // session was never activated, the OS already tore it down
            // when the app went background). Log so a flood is visible
            // but do not surface as a plugin error.
            print("[IOSCallAudio] setActive(false) [\(reason)] failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Status

    @objc func getStatus(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        let outputs = session.currentRoute.outputs.map { $0.portType.rawValue }
        let inputs = session.currentRoute.inputs.map { $0.portType.rawValue }

        let isSpeakerOn = outputs.contains(AVAudioSession.Port.builtInSpeaker.rawValue)
        let isBtScoOn = outputs.contains(AVAudioSession.Port.bluetoothHFP.rawValue)
            || inputs.contains(AVAudioSession.Port.bluetoothHFP.rawValue)

        // Translate to Android-shaped mode strings so the JS-side
        // audio-watchdog and bug-reporter don't need a per-platform
        // branch to read the value.
        let isInComm = (session.category == .playAndRecord)
        let mode = isInComm ? "MODE_IN_COMMUNICATION" : "MODE_NORMAL"

        call.resolve([
            "mode": mode,
            "isSpeakerOn": isSpeakerOn,
            "isBtScoOn": isBtScoOn,
        ])
    }

    /// Override the output port (speaker vs earpiece). v1 only honors
    /// `"speaker"` and `"earpiece"`/`"default"` — wire-headset and
    /// Bluetooth routing are owned by iOS's own route picker (Control
    /// Center "AirPlay" sheet) since CallKit cannot grant us programmatic
    /// access to specific BT devices.
    @objc func setOutput(_ call: CAPPluginCall) {
        guard let target = call.getString("device") else {
            call.reject("device required")
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            switch target {
            case "speaker":
                try session.overrideOutputAudioPort(.speaker)
            case "earpiece", "default":
                try session.overrideOutputAudioPort(.none)
            default:
                // Unknown target — no-op. Don't reject; UI may surface
                // route options that the platform doesn't honor (e.g.
                // "bluetooth"), and we'd rather silently ignore than
                // tear down the call.
                break
            }
            call.resolve()
        } catch {
            call.reject("overrideOutputAudioPort failed: \(error.localizedDescription)", nil, error)
        }
    }
}
