package com.forta.chat.plugins.calls

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Manages audio routing for VoIP calls.
 *
 * - Enumerates available audio devices (earpiece, speaker, bluetooth, wired headset)
 * - Selects active device via setCommunicationDevice (API 31+) or legacy APIs
 * - Auto-switches to Bluetooth when connected during a call
 * - Auto-fallback when Bluetooth disconnects
 * - Notifies core (JS/CallPlugin) and UI (CallActivity) listeners independently
 *
 * **Single instance per app** — obtained via [getSharedInstance]. Prior to this
 * Session 01 fix both [com.forta.chat.plugins.calls.CallPlugin] and
 * [com.forta.chat.plugins.calls.CallActivity] created their own AudioRouter.
 * Two AudioRouters each registered an AudioDeviceCallback and each issued their
 * own `setCommunicationDevice` on BT hot-swap, racing against each other — the
 * second call could silently undo the first, leaving the phone stuck on
 * earpiece while the user expected BT (#355, #442, #365). The shared instance
 * keeps a single AudioManager/mode state machine; [setCoreListener] /
 * [setUiListener] fan state updates out to JS and the call Activity in parallel.
 */
class AudioRouter private constructor(private val context: Context) {

    /**
     * Audio events for the current call, surfaced in bug reports. A snapshot
     * of the audio mode cannot distinguish "never left MODE_RINGTONE" from
     * "returned to it after the call", which need opposite fixes.
     */
    val timeline = CallAudioTimeline()

    companion object {
        private const val TAG = "AudioRouter"
        private const val LIFECYCLE_TAG = "AudioLifecycle"

        /**
         * Maximum lifetime of a single audio-routing session before the
         * watchdog forces a reset. Picked at 5 minutes because a real call
         * cycle is rarely longer than a few minutes for our user base; if
         * we have not seen a stop()/forceStop() by then, the JS finalize
         * path almost certainly never ran (process killed by OEM, Doze,
         * or battery-saver between hangup and stopAudioRouting).
         */
        private const val AUDIO_MAX_LIFETIME_MS = 5L * 60_000L

        @Volatile
        private var INSTANCE: AudioRouter? = null

        /**
         * Return the process-wide AudioRouter singleton, lazily creating it
         * with the application context. We deliberately use `applicationContext`
         * so the router survives CallActivity tear-down without leaking the
         * Activity — the router outlives any single UI surface.
         */
        fun getSharedInstance(context: Context): AudioRouter {
            val existing = INSTANCE
            if (existing != null) return existing
            return synchronized(this) {
                val local = INSTANCE
                if (local != null) return local
                val created = AudioRouter(context.applicationContext)
                INSTANCE = created
                created
            }
        }

        /**
         * Force a fresh instance. Only used in unit tests to clear state
         * between runs; production code must go through [getSharedInstance].
         */
        @androidx.annotation.VisibleForTesting
        internal fun resetForTests() {
            synchronized(this) {
                INSTANCE = null
            }
        }

        /**
         * WEE-110: test-friendly pure predicate for whether the device can
         * successfully create an AcousticEchoCanceler on a given session.
         *
         * Returns:
         *   - true: AcousticEchoCanceler.create(sessionId) succeeded
         *   - false: it returned null, or setEnabled threw
         *   - null: the check could not be performed (APIs not available,
         *           or an exception was caught)
         *
         * Exposed at companion scope so it can be covered by a JVM-only test
         * without running on a real device or mocking AudioEffect.
         */
        @androidx.annotation.VisibleForTesting
        internal fun canCreateHardwareAec(sessionId: Int): Boolean? {
            return try {
                // Check if the effect class is available at all
                if (!AcousticEchoCanceler.isAvailable()) {
                    return null // API available but effect not supported
                }
                // Try to create an instance
                val aec = AcousticEchoCanceler.create(sessionId)
                if (aec == null) {
                    return false // create() returned null
                }
                // Try to enable it
                try {
                    aec.enabled = true
                    val success = aec.hasControl()
                    aec.release()
                    return success
                } catch (e: Exception) {
                    aec.release()
                    return false // setEnabled threw
                }
            } catch (e: Exception) {
                // Audio APIs on some OEM ROMs are documented to throw
                // (MIUI privacy shield, Huawei AudioRecord guard). Fall back
                // to the vendor list in [VendorAudioPolicy].
                Log.w(LIFECYCLE_TAG, "canCreateHardwareAec threw", e)
                return null
            }
        }

        /**
         * Pure predicate used by the orphan-watchdog (Session 54).
         *
         * Returns true when the watchdog should brute-force restore
         * MODE_NORMAL: the router still thinks audio routing is active,
         * but the call infrastructure (WebRTC manager + foreground
         * service) is gone — meaning the JS-side stopAudioRouting never
         * reached us (OEM killed the process).
         *
         * Exposed at companion-object scope so it can be unit-tested
         * without spinning up a real AudioManager / Looper.
         */
        @androidx.annotation.VisibleForTesting
        internal fun shouldForceStopForWatchdog(
            callAlive: Boolean,
            isRouterActive: Boolean,
        ): Boolean = isRouterActive && !callAlive

        /**
         * Pure predicate for the WEE-16 extended OEM mode-reapply window.
         *
         * Returns true when the periodic watchdog should re-apply
         * MODE_IN_COMMUNICATION:
         *   - The router still thinks routing is active.
         *   - The OS reports a mode other than MODE_IN_COMMUNICATION,
         *     which means something (typically an aggressive OEM ROM)
         *     reset it after `start()` already applied the correct mode.
         *
         * Exposed at companion-object scope so it can be covered by a
         * JVM-only JUnit test without Robolectric / mockk.
         */
        @androidx.annotation.VisibleForTesting
        internal fun shouldReapplyMode(
            currentMode: Int,
            isActive: Boolean,
        ): Boolean = isActive && currentMode != AudioManager.MODE_IN_COMMUNICATION

        /**
         * Pure predicate for adopting a VoIP audio mode the router never set.
         *
         * `NativeWebRTCManager.startLocalAudio` writes
         * `MODE_IN_COMMUNICATION` itself, before the router starts, because
         * several OEM firmwares mute the microphone unless VoIP mode is
         * established before the first capture. That write has no owner: if
         * call setup fails afterwards, or the JS side never reaches
         * `startAudioRouting`, the router never becomes active — and
         * [stop] used to return on its `isActive` guard with the device still
         * in VoIP mode, so media volume stayed broken until the next app
         * resume. That is the "phone is stuck after a call" report.
         *
         * Restricted to `MODE_IN_COMMUNICATION` on purpose: `MODE_IN_CALL`
         * belongs to a cellular call and `MODE_RINGTONE` to the system
         * ringer, and resetting either would break something that is not ours.
         */
        @androidx.annotation.VisibleForTesting
        internal fun shouldAdoptStrandedMode(
            isActive: Boolean,
            currentMode: Int,
        ): Boolean = !isActive && currentMode == AudioManager.MODE_IN_COMMUNICATION

        /**
         * Pure predicate for the watchdog armed by [ensureCommunicationMode]
         * when the router was not yet active: VoIP mode was set on behalf of
         * a call that never reached [start] (or whose foreground service is
         * gone), so nobody else will reset it.
         */
        @androidx.annotation.VisibleForTesting
        internal fun shouldForceStopAfterEnsure(
            isRouterActive: Boolean,
            currentMode: Int?,
            callAlive: Boolean,
        ): Boolean = !isRouterActive && !callAlive &&
            currentMode == AudioManager.MODE_IN_COMMUNICATION

        /**
         * The ensure watchdog stays armed while the call is still alive but
         * routing never started; [start] cancels it, and a dead call resolves
         * through [shouldForceStopAfterEnsure].
         */
        @androidx.annotation.VisibleForTesting
        internal fun shouldRearmEnsureWatchdog(
            isRouterActive: Boolean,
            callAlive: Boolean,
        ): Boolean = !isRouterActive && callAlive

        private const val SESSION_PREFS = "forta_audio_router"
        private const val SESSION_OPEN_KEY = "session_open"

        /**
         * Whether a previous audio session was opened and never closed — the
         * marker is written to disk on [start] / [ensureCommunicationMode]
         * and cleared by [stop] / [forceStop], so it survives process death.
         * The audio mode is global and carries no owner: without this marker
         * a cold-start sweep could not tell our stranded VoIP mode from
         * another app's live call and would reset that call's audio.
         */
        fun hasOpenSessionMarker(context: Context): Boolean =
            context.applicationContext
                .getSharedPreferences(SESSION_PREFS, Context.MODE_PRIVATE)
                .getBoolean(SESSION_OPEN_KEY, false)

        /**
         * Close the marker without touching audio. For the cold-start sweep:
         * a fresh process cannot have a session of ours open, so whatever the
         * marker says about the previous one is settled once the sweep ran.
         */
        fun clearSessionMarker(context: Context) {
            try {
                context.applicationContext
                    .getSharedPreferences(SESSION_PREFS, Context.MODE_PRIVATE)
                    .edit().putBoolean(SESSION_OPEN_KEY, false).apply()
            } catch (e: Exception) {
                Log.w(LIFECYCLE_TAG, "session marker clear threw", e)
            }
        }

        /**
         * WEE-16: schedule of re-apply ticks (in ms after `start()`).
         *
         * The original single 500 ms re-apply caught fast OEM resets
         * (MIUI/RealmeUI/XOS) but missed slower resets observed on
         * Huawei P70 / Xiaomi 12X — those reset MODE_IN_COMMUNICATION
         * 1–5 s after acceptCall, leaving the user with one-way or
         * fully silent audio. The schedule below covers that window
         * without burning CPU on long-running calls (re-apply stops
         * after the last tick because OEM resets are start-of-call
         * behaviour — once the call survives the first ~8 s, audio
         * mode stays stable for the rest of the session).
         */
        @androidx.annotation.VisibleForTesting
        internal fun modeReapplyScheduleMs(): List<Long> =
            listOf(500L, 1_500L, 3_500L, 7_500L)

        /**
         * WEE-60: pure predicate for re-applying the vendor mic-unmute inside
         * the OEM re-apply window.
         *
         * [applyVendorStartTweaks] clears the global mic-mute flag once at t=0
         * for the broken-HW-AEC family that needs it (HONOR MagicOS; realme /
         * OPPO / Xiaomi — WEE-87; Infinix / ZTE / Huawei — WEE-103), but those
         * same aggressive HALs can re-assert that flag in the same async window
         * they reset the audio
         * mode (the [modeReapplyScheduleMs] ticks). When that happens the
         * one-time unmute is clobbered and the peer hears one-way silence.
         *
         * Returns true only when ALL of:
         *   - the vendor required the explicit start-time unmute, AND
         *   - routing is still active (don't fight a fresh call after stop), AND
         *   - the mic is actually muted right now (no-op otherwise).
         *
         * Re-applying `setMicrophoneMute(false)` is safe even on intentional
         * user mutes: the in-call Mute button toggles the WebRTC track
         * (`MatrixCall.setMicrophoneMuted` → `track.enabled`), never this
         * process-global AudioManager flag, so clearing it can only release an
         * OEM-stuck capture path.
         *
         * Companion-scope so a JVM-only test covers it without AudioManager.
         */
        @androidx.annotation.VisibleForTesting
        internal fun shouldReapplyMicUnmute(
            requiresUnmute: Boolean,
            isActive: Boolean,
            isMicMuted: Boolean,
        ): Boolean = requiresUnmute && isActive && isMicMuted

        /**
         * WEE-54 / forta-bugs#860 — Samsung A15 (Android 15) bidirectional
         * silence guard.
         *
         * When [setDeviceModern] cannot find the requested device in
         * `availableCommunicationDevices`, the old behaviour was to call
         * `clearCommunicationDevice()`. For a *removable* device (Bluetooth /
         * wired headset) that genuinely went away that is correct — fall back
         * to the system default. But the built-in earpiece and speaker ALWAYS
         * physically exist; their absence from the freshly-enumerated comm-
         * device list is a transient timing artifact on Android 15, where the
         * list can be momentarily empty right after `mode` flips to
         * MODE_IN_COMMUNICATION. Clearing the communication device in that
         * window tears down the only routing the call has and leaves both
         * parties in total silence (#860 on Samsung SM-G991B / A15).
         *
         * So: only clear for removable devices; for built-in earpiece/speaker
         * keep whatever routing the system already chose (default is the
         * earpiece in communication mode) and let the OEM mode-reapply window
         * settle the enumeration. Pure predicate so it is covered by a JVM
         * unit test without a real AudioManager.
         */
        @androidx.annotation.VisibleForTesting
        internal fun shouldClearWhenTargetMissing(device: Device): Boolean =
            device == Device.BLUETOOTH || device == Device.WIRED_HEADSET

        /**
         * WEE-76 (#944/#960) — desired legacy `isSpeakerphoneOn` value used to
         * reinforce the modern [setCommunicationDevice] route for the built-in
         * earpiece/speaker pair.
         *
         * Multi-user reports on 1.10.38/39 show the in-call speaker button never
         * engaging the loudspeaker. On API 31+ the toggle routes ONLY through
         * `setCommunicationDevice(TYPE_BUILTIN_SPEAKER)`, which on several OEMs
         * is a silent no-op: it returns `false` under audio-stack contention, or
         * `TYPE_BUILTIN_SPEAKER` is momentarily absent from
         * `availableCommunicationDevices` (the WEE-54 guard then deliberately
         * keeps the current earpiece route to avoid the A15 silence bug). Either
         * way an explicit user tap does nothing — exactly the #944/#960 symptom,
         * confirmed across multiple users (not a single OEM).
         *
         * The legacy `isSpeakerphoneOn` flag is the reliable cross-OEM switch for
         * the built-in loudspeaker, so we mirror it to the requested built-in
         * device after the modern call. It expresses the same routing as the
         * modern path (no conflict on healthy devices) and is the same mechanism
         * the API < 31 path ([setDeviceLegacy]) already uses.
         *
         * Returns:
         *   - `true`  → engage the loudspeaker (SPEAKER)
         *   - `false` → disengage the loudspeaker (EARPIECE)
         *   - `null`  → leave untouched (BLUETOOTH / WIRED_HEADSET are owned by
         *               [setCommunicationDevice]; the legacy flag must not fight
         *               them — A5: zero change to the proven BT/wired path).
         *
         * Companion-scope so a JVM-only test covers it without an AudioManager.
         */
        @androidx.annotation.VisibleForTesting
        internal fun legacySpeakerphoneTarget(device: Device): Boolean? = when (device) {
            Device.SPEAKER -> true
            Device.EARPIECE -> false
            Device.BLUETOOTH, Device.WIRED_HEADSET -> null
        }
    }

    enum class Device(val label: String) {
        EARPIECE("Earpiece"),
        SPEAKER("Speaker"),
        BLUETOOTH("Bluetooth"),
        WIRED_HEADSET("Wired Headset")
    }

    data class AudioDeviceState(
        val available: List<Device>,
        val active: Device
    )

    interface Listener {
        fun onAudioDeviceChanged(state: AudioDeviceState)
    }

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val mainHandler = Handler(Looper.getMainLooper())
    // Single monitor for start/stop/forceStop so a watchdog forceStop
    // cannot interleave with a concurrent start (would otherwise leave
    // the router with isActive=true but mode=NORMAL — exactly the stuck
    // state Session 23 is trying to prevent).
    private val lifecycleLock = Any()
    // coreListener is owned by CallPlugin (JS-facing). uiListener is owned by
    // CallActivity. Keeping them separate means onDestroy in the Activity does
    // not tear down the JS-facing callback registered earlier by CallPlugin.
    // Both @Volatile because notifyListener reads them from the main-handler
    // thread while setCoreListener/setUiListener may be invoked from Capacitor
    // plugin threads that don't share a happens-before with the main handler.
    @Volatile private var coreListener: Listener? = null
    @Volatile private var uiListener: Listener? = null
    private var activeDevice: Device = Device.EARPIECE

    // The device the user picked by hand during this call (setDevice from
    // the in-call UI). Read by handleDevicesChanged through AudioRoutePolicy;
    // cleared by start() so a pin never outlives its call.
    @Volatile private var pinnedDevice: Device? = null

    // Guards the pin together with the route it belongs to. setDevice runs
    // on the plugin thread, handleDevicesChanged on the main handler; a
    // volatile alone leaves "read pin → decide → clear pin → route" open to
    // a tap landing in the middle, which would let a Bluetooth event route
    // over a loudspeaker the user had just chosen.
    private val routeLock = Any()
    // WEE-56: coarse OEM classification used for vendor-conditional audio
    // tweaks. Resolved once from Build at construction — the manufacturer
    // does not change at runtime. GENERIC for any unrecognised device, so the
    // proven WEE-54 generic path is the default and vendor branches are purely
    // additive (acceptance criterion A5).
    private val vendor: CallVendor = VendorAudioPolicy.detect(Build.MANUFACTURER, Build.BRAND)
    // WEE-103: whether this device's audio HAL strands the mic-mute flag asserted
    // on call setup (the broken-HW-AEC family). Resolved once from Build like
    // [vendor]; keyed off manufacturer/brand rather than the coarse CallVendor
    // enum so OEMs that detect() classifies as GENERIC (Infinix/XOS #1008,
    // ZTE/nubia #1009) — and HUAWEI (#1009) — are no longer missed by the gate.
    // Also consults a runtime probe so devices outside the vendor list whose HW
    // AEC fails at runtime are covered too (WEE-110). The probe is passed as a
    // provider, not a value: a listed vendor is already decided by the list, and
    // creating an AcousticEchoCanceler on those ROMs is exactly the kind of call
    // this file elsewhere documents as prone to throwing. Resolved lazily, so
    // the probe runs at most once and only on the first call of the process.
    private val requiresMicUnmute: Boolean by lazy {
        VendorAudioPolicy.requiresExplicitMicUnmuteOnStart(
            Build.MANUFACTURER,
            Build.BRAND,
            ::queryHardwareAecAvailability,
        )
    }
    // WEE-16: @Volatile so the periodic re-apply runnables observe a
    // stop()/forceStop()-side write across threads. start()/stop()/
    // forceStop() are invoked from arbitrary Capacitor plugin threads
    // while the runnables run on the main handler. Without this barrier
    // a runnable could see isActive=true after stop() set it to false
    // and re-apply MODE_IN_COMMUNICATION on top of stop()'s MODE_NORMAL
    // restore — exactly the regression the OEM-reset window is trying
    // to prevent. The lifecycleLock around start/stop/forceStop gives
    // mutual exclusion among themselves but does not synchronize with
    // the lock-free runnables.
    @Volatile private var isActive = false
    private var callType = "voice"

    /**
     * The call that owns the routing (C02). A stop sent for another call is
     * dropped — see [AudioRouterOwnership]. Guarded by [lifecycleLock].
     */
    private var ownerCallId: String? = null
    private var bluetoothDeviceName: String? = null

    // Session 54: cancellable Runnables. The 500ms re-apply runnable used to
    // be an anonymous lambda we could never cancel — on ultra-fast hangups
    // (stop() within 500ms of start()) it would fire after stop() and put
    // the device back into MODE_IN_COMMUNICATION. The orphan watchdog needs
    // the same cancel guarantee: stop()/forceStop() must remove it so a
    // healthy hangup does not later trigger a redundant forceStop.
    //
    // WEE-16: a single 500ms re-apply only catches fast OEM resets (MIUI /
    // RealmeUI / XOS). Slower resets observed on Huawei P70 / Xiaomi 12X
    // (1–5 s after start) slipped through and left peers hearing silence.
    // We now schedule the whole [modeReapplyScheduleMs] list and track
    // every runnable here so stop()/forceStop() can cancel each one.
    private val reapplyRunnables = mutableListOf<Runnable>()
    private var stopWatchdog: Runnable? = null
    // Armed by ensureCommunicationMode() when the router is not yet active;
    // cancelled by start()/stop()/forceStop(). See shouldForceStopAfterEnsure.
    private var ensureWatchdog: Runnable? = null

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            Log.d(TAG, "Devices added: ${addedDevices.map { deviceTypeToString(it.type) }}")
            handleDevicesChanged()
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            Log.d(TAG, "Devices removed: ${removedDevices.map { deviceTypeToString(it.type) }}")
            handleDevicesChanged()
        }
    }

    private val btScoReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED -> {
                    val state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)
                    Log.d(TAG, "BT SCO state: $state")
                    if (state == AudioManager.SCO_AUDIO_STATE_CONNECTED) {
                        activeDevice = Device.BLUETOOTH
                        notifyListener()
                    } else if (state == AudioManager.SCO_AUDIO_STATE_DISCONNECTED && activeDevice == Device.BLUETOOTH) {
                        val fallback = if (callType == "video") Device.SPEAKER else Device.EARPIECE
                        setDeviceInternal(fallback)
                    }
                }
            }
        }
    }

    /**
     * WEE-110: probe the device's hardware AEC capability so
     * [VendorAudioPolicy] can make an informed decision about whether to fall
     * back to software processing. Called at most once per process, on the
     * first call, and only for devices the vendor list does not already cover.
     *
     * Returns the result of [canCreateHardwareAec], which is:
     *   - true: HW AEC can be created and enabled
     *   - false: HW AEC creation/enable failed (device has broken HW AEC)
     *   - null: the check could not be performed (API unavailable or threw)
     *
     * When null, [VendorAudioPolicy] falls back to the vendor list.
     */
    private fun queryHardwareAecAvailability(): Boolean? {
        // Session 0 is AUDIO_SESSION_ID_GENERATE — no live capture is attached,
        // because the WebRTC session does not exist yet. A HAL that will only
        // engage AEC against a real stream can therefore answer "no control"
        // here, which reads as false rather than null: this probe can say a
        // healthy device has broken HW AEC, never the reverse. That direction
        // is safe for the one thing it feeds — an explicit mic unmute only ever
        // releases a stranded capture path, it cannot break a working one — so
        // do NOT wire this value into the AEC engine choice without first
        // probing against a live AudioRecord session.
        return canCreateHardwareAec(0)
    }

    fun start(callType: String, callId: String? = null) = synchronized(lifecycleLock) {
        // Idempotent: second start() in the same call cycle (e.g. JS side
        // hits startAudioRouting twice because of renegotiation) must not
        // re-register device callbacks or the same callback would fire
        // twice per device add/remove.
        // Synchronized with stop()/forceStop() so a watchdog forceStop
        // racing a fresh start() cannot interleave half-set state.
        if (isActive) {
            // C02: a new call starting while the previous call's stop is still
            // queued takes the routing over, so that late stop is dropped.
            val owner = AudioRouterOwnership.ownerAfterStart(ownerCallId, callId)
            if (owner != ownerCallId) {
                Log.w(LIFECYCLE_TAG, "start($callType) — already active, ownership $ownerCallId -> $owner")
                timeline.record("owner_change", owner ?: "")
                ownerCallId = owner
            }
            Log.w(LIFECYCLE_TAG, "start($callType) — already active, no-op (current callType=${this.callType})")
            return@synchronized
        }

        this.callType = callType
        this.isActive = true
        this.ownerCallId = callId

        // One timeline per call: the previous call's entries would only
        // confuse triage. An orphaned router never reaches start(), so its
        // stale entries survive — which is exactly the case worth seeing.
        timeline.clear()
        timeline.record("start", callType)

        activeDevice = if (callType == "video") Device.SPEAKER else Device.EARPIECE
        pinnedDevice = null
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        timeline.record("mode", "MODE_IN_COMMUNICATION")
        // From here the session has a real owner with its own watchdog; the
        // pre-start ensure watchdog would only race it.
        ensureWatchdog?.let { mainHandler.removeCallbacks(it) }
        ensureWatchdog = null
        markSessionOpen()
        Log.d(LIFECYCLE_TAG, "start($callType): set mode=MODE_IN_COMMUNICATION, initial active=$activeDevice")

        // OEM fix: Some Chinese ROMs (MIUI, RealmeUI, XOS, HyperOS, EMUI,
        // HarmonyOS) reset audio mode asynchronously after init. WEE-16:
        // a single 500ms re-apply caught fast OEMs but missed slower resets
        // on Huawei P70 / Xiaomi 12X (1–5s after start), leaving the peer
        // with one-way or fully silent audio. We schedule the whole
        // [modeReapplyScheduleMs] list; each runnable is stored so stop()
        // / forceStop() can cancel any that haven't fired yet on hangup.
        cancelReapplyRunnables()
        for (delayMs in modeReapplyScheduleMs()) {
            val reapply = Runnable {
                // Wrap the WHOLE body — `audioManager.mode` getter is
                // documented to throw SecurityException on the exact
                // OEM ROMs we're trying to recover (MIUI privacy shield,
                // Huawei AudioRecord guard). Letting that escape into
                // the main handler crashes the process.
                try {
                    if (shouldReapplyMode(audioManager.mode, isActive)) {
                        Log.w(
                            LIFECYCLE_TAG,
                            "Audio mode reset detected at +${delayMs}ms — re-applying MODE_IN_COMMUNICATION",
                        )
                        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                        timeline.record("mode_reapply", "+${delayMs}ms")
                    }
                    // WEE-60: the OEM that resets the audio mode in this window
                    // can also re-assert the global mic-mute flag, clobbering the
                    // t=0 applyVendorStartTweaks() unmute and leaving the peer with
                    // one-way silence. Re-release it on every tick for vendors that
                    // need it (gated + mic-actually-muted guard → no-op otherwise).
                    if (
                        shouldReapplyMicUnmute(
                            requiresMicUnmute,
                            isActive,
                            audioManager.isMicrophoneMute,
                        )
                    ) {
                        audioManager.setMicrophoneMute(false)
                        timeline.record("mic_unmute", "reapply +${delayMs}ms")
                        Log.w(
                            LIFECYCLE_TAG,
                            "[vendor=$vendor] OEM re-muted mic at +${delayMs}ms — releasing",
                        )
                    }
                } catch (e: Exception) {
                    Log.w(LIFECYCLE_TAG, "Re-apply tick at +${delayMs}ms threw", e)
                }
            }
            reapplyRunnables.add(reapply)
            mainHandler.postDelayed(reapply, delayMs)
        }

        // Session 54: orphan-call watchdog. If the JS finalize never runs
        // (process killed by OEM Doze / battery-saver between hangup and
        // stopAudioRouting), AudioRouter stays in MODE_IN_COMMUNICATION
        // forever and the phone's media volume is broken until reboot.
        // Every AUDIO_MAX_LIFETIME_MS we check whether the call foreground
        // service is still running; if not, we forceStop() ourselves.
        // (WebRTCPlugin.manager is plugin-lifetime, not call-lifetime, so
        // including it in the predicate would never trip — the call
        // foreground service is the actual call-liveness signal.)
        stopWatchdog?.let { mainHandler.removeCallbacks(it) }
        val watchdog = object : Runnable {
            override fun run() {
                val callAlive = CallForegroundService.isRunning
                if (shouldForceStopForWatchdog(callAlive = callAlive, isRouterActive = isActive)) {
                    timeline.record("watchdog", "orphaned router — forcing stop")
                    Log.w(
                        LIFECYCLE_TAG,
                        "Audio watchdog: no active call after ${AUDIO_MAX_LIFETIME_MS}ms — forceStop",
                    )
                    forceStop()
                } else if (isActive) {
                    // Call still alive (or router was already stopped) —
                    // rearm for another window. Only rearm while we still
                    // believe routing is active; if isActive is false we
                    // are already torn down and rescheduling would be a leak.
                    mainHandler.postDelayed(this, AUDIO_MAX_LIFETIME_MS)
                }
            }
        }
        stopWatchdog = watchdog
        mainHandler.postDelayed(watchdog, AUDIO_MAX_LIFETIME_MS)

        audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler)

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            val filter = IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
            context.registerReceiver(btScoReceiver, filter)
        }

        val available = getAvailableDevices()
        if (Device.BLUETOOTH in available) {
            // Auto-selection, not a pin: only setDevice() from the UI pins.
            setDeviceInternal(Device.BLUETOOTH)
            notifyListener()
        } else {
            setDeviceInternal(activeDevice)
        }

        applyVendorStartTweaks()

        Log.d(
            LIFECYCLE_TAG,
            "start($callType) complete: active=$activeDevice, available=$available, " +
                "vendor=$vendor manuf=${Build.MANUFACTURER} brand=${Build.BRAND}",
        )
    }

    /**
     * WEE-56: vendor-conditional reinforcement applied AFTER the generic
     * routing in [start]. Purely additive — every branch is gated on a
     * [VendorAudioPolicy] predicate that returns the generic answer for
     * unrecognised devices, so this is a no-op on the working majority.
     */
    private fun applyVendorStartTweaks() {
        // Broken-HW-AEC family (HONOR MagicOS #872/#873; realme/OPPO/Xiaomi
        // WEE-87 #993/#994/#995; Infinix/XOS #1008, ZTE/nubia + Huawei #1009 —
        // WEE-103): the comm-device routing above can leave the global mic-mute
        // flag asserted, producing one-way or both-ways silence while video plays.
        // An explicit unmute releases the capture path. Wrapped because the setter
        // is documented to throw on a few privacy-shield ROMs and must never crash
        // call setup.
        if (requiresMicUnmute) {
            try {
                audioManager.setMicrophoneMute(false)
                timeline.record("mic_unmute", "vendor start tweak")
                Log.d(LIFECYCLE_TAG, "[vendor=$vendor] explicit setMicrophoneMute(false) on start")
            } catch (e: Exception) {
                Log.w(LIFECYCLE_TAG, "[vendor=$vendor] setMicrophoneMute(false) on start threw", e)
            }
        }
    }

    /**
     * Put the device in `MODE_IN_COMMUNICATION` on the router's behalf.
     *
     * Two surfaces used to write the mode directly: `NativeWebRTCManager`
     * before the first capture (several OEM firmwares mute the microphone
     * unless VoIP mode is established first), and `CallActivity.onResume`
     * restoring it during a live call. Neither write had an owner, so when the
     * call never reached [start] — or the process died before [stop] — the
     * mode stayed set until reboot. Routing both through here gives the write
     * a timeline entry, the persisted session marker and a watchdog.
     *
     * Deliberately does not flip [isActive]: [start] is idempotent on that
     * flag and must still run its device selection and callbacks afterwards.
     */
    fun ensureCommunicationMode(source: String) = synchronized(lifecycleLock) {
        val current = runCatching { audioManager.mode }.getOrNull()
        if (current == AudioManager.MODE_IN_COMMUNICATION) return@synchronized
        try {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        } catch (e: Exception) {
            Log.w(LIFECYCLE_TAG, "ensureCommunicationMode($source): setMode threw", e)
            return@synchronized
        }
        if (isActive) {
            // The OS (or an OEM ROM) reset a mode we own; the re-apply ticks
            // and the orphan watchdog from start() are still armed.
            timeline.record("mode_reapply", source)
            Log.w(LIFECYCLE_TAG, "ensureCommunicationMode($source): re-applied MODE_IN_COMMUNICATION")
            return@synchronized
        }
        timeline.record("mode_ensure", source)
        markSessionOpen()
        Log.d(LIFECYCLE_TAG, "ensureCommunicationMode($source): set MODE_IN_COMMUNICATION before start()")
        ensureWatchdog?.let { mainHandler.removeCallbacks(it) }
        val watchdog = object : Runnable {
            override fun run() {
                val callAlive = CallForegroundService.isRunning
                val mode = runCatching { audioManager.mode }.getOrNull()
                if (shouldForceStopAfterEnsure(isActive, mode, callAlive)) {
                    Log.w(LIFECYCLE_TAG, "Ensure watchdog: VoIP mode set for a call that never started routing — forceStop")
                    forceStop("ensure_watchdog")
                } else if (shouldRearmEnsureWatchdog(isActive, callAlive)) {
                    mainHandler.postDelayed(this, AUDIO_MAX_LIFETIME_MS)
                }
            }
        }
        ensureWatchdog = watchdog
        mainHandler.postDelayed(watchdog, AUDIO_MAX_LIFETIME_MS)
    }

    /** Whether [start] ran and [stop]/[forceStop] have not yet. */
    fun isRoutingActive(): Boolean = isActive

    private fun markSessionOpen() {
        // apply(), not commit(): this runs on the capture hot path, under
        // NativeWebRTCManager's media lock as well as ours, and a blocking
        // disk write there is what the OEM mic-mute workaround is timing-
        // sensitive about. apply() is flushed before lifecycle transitions;
        // the only way to lose it is a SIGKILL in the same instant, and a lost
        // marker fails safe — the next cold start leaves the mode alone.
        try {
            context.getSharedPreferences(SESSION_PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(SESSION_OPEN_KEY, true).apply()
        } catch (e: Exception) {
            Log.w(LIFECYCLE_TAG, "session marker write threw", e)
        }
    }

    private fun markSessionClosed() {
        // A lost close is equally safe: the next cold start finds the marker
        // open with a normal mode, does nothing, and clears it.
        try {
            context.getSharedPreferences(SESSION_PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(SESSION_OPEN_KEY, false).apply()
        } catch (e: Exception) {
            Log.w(LIFECYCLE_TAG, "session marker clear threw", e)
        }
    }

    /**
     * Stop the routing for [callId]. Returns false when the router belongs to
     * another call and the stop was dropped (C02); null [callId] always stops.
     */
    fun stop(callId: String? = null): Boolean = synchronized(lifecycleLock) {
        if (!AudioRouterOwnership.shouldStop(callId, ownerCallId)) {
            Log.w(LIFECYCLE_TAG, "stop($callId) — router owned by $ownerCallId, ignored")
            timeline.record("stop_ignored_other_owner", callId ?: "")
            return@synchronized false
        }
        ownerCallId = null
        stopRouting()
        true
    }

    private fun stopRouting() = synchronized(lifecycleLock) {
        // Idempotent: every call lifecycle path ends with stopAudioRouting
        // (hangup, reject, SDK state=Ended, answer-errored, permission-denied),
        // so calling stop twice happens routinely. Without the guard we would
        // unregisterAudioDeviceCallback on an already-unregistered callback
        // and log a spurious warning.
        if (!isActive) {
            // Adopt a VoIP mode nobody else will reset — see
            // [shouldAdoptStrandedMode]. The monitor is reentrant, so
            // delegating to forceStop() inside the lock is safe.
            val currentMode = runCatching { audioManager.mode }.getOrNull()
            if (currentMode != null && shouldAdoptStrandedMode(isActive, currentMode)) {
                Log.w(
                    LIFECYCLE_TAG,
                    "stop() — inactive but device left in MODE_IN_COMMUNICATION, brute-resetting",
                )
                timeline.record("stop_adopted_stranded_mode")
                forceStop()
                return@synchronized
            }
            // Nothing of ours is open once stop() is called; a marker left
            // behind by ensureCommunicationMode() after the OS already reset
            // the mode must not survive to claim another app's call later.
            markSessionClosed()
            Log.w(LIFECYCLE_TAG, "stop() — already inactive, no-op")
            return@synchronized
        }

        isActive = false
        timeline.record("stop")

        // Session 54: cancel the orphan watchdog and the OEM re-apply
        // runnables before tearing down. Without these removeCallbacks,
        // a healthy hangup followed by an immediate new call would see
        // the previous call's watchdog still scheduled, and any pending
        // re-apply tick could fire after the new start() had set the mode.
        // WEE-16: the single runnable is now a list (modeReapplyScheduleMs).
        stopWatchdog?.let { mainHandler.removeCallbacks(it) }
        stopWatchdog = null
        ensureWatchdog?.let { mainHandler.removeCallbacks(it) }
        ensureWatchdog = null
        cancelReapplyRunnables()

        // Session 23: previously a single call chain. If
        // unregisterAudioDeviceCallback or BT SCO teardown threw, the
        // mode=NORMAL / clearCommunicationDevice path was skipped and
        // the device stayed in MODE_IN_COMMUNICATION until reboot —
        // music played at low volume through the earpiece, new calls
        // had zero-way audio. try/finally guarantees the audio mode is
        // always restored regardless of any exception above it.
        try {
            try {
                audioManager.unregisterAudioDeviceCallback(deviceCallback)
            } catch (e: Exception) {
                Log.w(LIFECYCLE_TAG, "unregisterAudioDeviceCallback threw", e)
            }

            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                try {
                    context.unregisterReceiver(btScoReceiver)
                } catch (_: Exception) {}
                stopBluetoothScoSafely()
            }
        } finally {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice()
                }
            } catch (e: Exception) {
                Log.w(LIFECYCLE_TAG, "clearCommunicationDevice threw", e)
            }

            try {
                audioManager.mode = AudioManager.MODE_NORMAL
                markSessionClosed()
            } catch (e: Exception) {
                Log.w(LIFECYCLE_TAG, "setMode(MODE_NORMAL) threw", e)
            }

            try {
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = false
            } catch (_: Exception) {}

            releaseGlobalMicMute()

            Log.d(LIFECYCLE_TAG, "stop(): set mode=MODE_NORMAL, cleared comm device")
        }
    }

    /**
     * WEE-56 (#875 / #898 / #900 + cross-app "Telegram voice empty" report):
     * clear the process-global microphone-mute flag on call teardown so other
     * apps can record afterwards. `setMicrophoneMute` is global state — if any
     * path left it asserted, every other recorder captures silence until
     * reboot. Resetting it can only release a stuck capture path, so the policy
     * is vendor-independent. Wrapped because the setter throws on some OEM
     * privacy-shield ROMs and teardown must never crash.
     */
    private fun releaseGlobalMicMute() {
        if (!VendorAudioPolicy.shouldUnmuteMicOnStop(vendor)) return
        try {
            audioManager.setMicrophoneMute(false)
        } catch (e: Exception) {
            Log.w(LIFECYCLE_TAG, "setMicrophoneMute(false) on teardown threw", e)
        }
    }

    /**
     * WEE-16: remove every pending OEM-mode re-apply runnable from the
     * main handler and clear the tracking list. Idempotent — calling
     * twice (start() → start() before stop()) is a no-op on the second
     * call because the list is empty.
     */
    private fun cancelReapplyRunnables() {
        if (reapplyRunnables.isEmpty()) return
        for (r in reapplyRunnables) mainHandler.removeCallbacks(r)
        reapplyRunnables.clear()
    }

    /**
     * On API < 31 stopBluetoothSco is asynchronous: the audio framework
     * tears down the SCO link via a broadcast. Resetting audio mode
     * before that broadcast arrives leaves routing in an inconsistent
     * state — the next stream lands on SCO mono (silent or distorted).
     *
     * Wait for STATE_DISCONNECTED with a 500ms upper bound so a stuck
     * BT stack cannot block hangup forever.
     */
    private fun stopBluetoothScoSafely() {
        if (!audioManager.isBluetoothScoOn) return

        val latch = java.util.concurrent.CountDownLatch(1)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val state = i?.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1) ?: return
                if (state == AudioManager.SCO_AUDIO_STATE_DISCONNECTED) latch.countDown()
            }
        }

        try {
            context.registerReceiver(receiver, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
            audioManager.isBluetoothScoOn = false
            audioManager.stopBluetoothSco()
            latch.await(500, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            Log.w(LIFECYCLE_TAG, "stopBluetoothScoSafely threw", e)
        } finally {
            try { context.unregisterReceiver(receiver) } catch (_: Exception) {}
        }
    }

    /**
     * Public force-reset. Bypasses the [isActive] guard and brute-force
     * restores audio state. Used by the app-resume watchdog when a
     * previous call's cleanup never ran (JS process killed, OEM stopped
     * the foreground service) and the device is stuck in
     * MODE_IN_COMMUNICATION.
     */
    fun forceStop(reason: String = "brute reset") = synchronized(lifecycleLock) {
        Log.w(LIFECYCLE_TAG, "forceStop($reason) — bypassing guards, brute reset")
        timeline.record("force_stop", reason)
        isActive = false
        ownerCallId = null
        ensureWatchdog?.let { mainHandler.removeCallbacks(it) }
        ensureWatchdog = null

        // Session 54: same cancellation as stop() — the watchdog itself
        // may have triggered this forceStop, but a no-op removeCallbacks
        // on the currently-executing Runnable is safe and prevents the
        // (cancelled) reapply runnables from outliving us. WEE-16: the
        // single runnable is now a list (modeReapplyScheduleMs).
        stopWatchdog?.let { mainHandler.removeCallbacks(it) }
        stopWatchdog = null
        cancelReapplyRunnables()

        try { audioManager.unregisterAudioDeviceCallback(deviceCallback) } catch (_: Exception) {}

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            try { context.unregisterReceiver(btScoReceiver) } catch (_: Exception) {}
            try {
                if (audioManager.isBluetoothScoOn) {
                    audioManager.isBluetoothScoOn = false
                    audioManager.stopBluetoothSco()
                }
            } catch (_: Exception) {}
        } else {
            try { audioManager.clearCommunicationDevice() } catch (_: Exception) {}
        }

        try {
            audioManager.mode = AudioManager.MODE_NORMAL
            markSessionClosed()
        } catch (_: Exception) {}
        @Suppress("DEPRECATION")
        try { audioManager.isSpeakerphoneOn = false } catch (_: Exception) {}
        releaseGlobalMicMute()

        Log.d(LIFECYCLE_TAG, "forceStop($reason) complete")
    }

    /**
     * Register the core (non-UI) listener. Owned by [com.forta.chat.plugins.calls.CallPlugin];
     * it fans state changes out to JS via notifyListeners("audioDevicesChanged").
     * Survives across call UI tear-down.
     */
    fun setCoreListener(listener: Listener?) {
        this.coreListener = listener
    }

    /**
     * Register the UI-facing listener. Owned by [com.forta.chat.plugins.calls.CallActivity];
     * updates the in-call speakerphone/BT icon. Attach on Activity onCreate,
     * detach on onDestroy — do not call [stop] from the Activity, that is
     * driven by the call lifecycle in JS (`nativeCallBridge.stopAudioRouting`).
     */
    fun setUiListener(listener: Listener?) {
        this.uiListener = listener
    }

    /**
     * Back-compat: existing callers (tests, older code paths) that do not
     * distinguish core vs UI can still use the single-listener API. Maps to
     * the core listener slot since that is what external consumers treated
     * as the "real" one.
     */
    fun setListener(listener: Listener?) {
        setCoreListener(listener)
    }

    fun getAvailableDevices(): List<Device> {
        val devices = mutableListOf<Device>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val commDevices = audioManager.availableCommunicationDevices
            for (d in commDevices) {
                when (d.type) {
                    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> devices.add(Device.EARPIECE)
                    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> devices.add(Device.SPEAKER)
                    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
                    AudioDeviceInfo.TYPE_BLE_SPEAKER -> {
                        if (Device.BLUETOOTH !in devices) {
                            bluetoothDeviceName = d.productName?.toString()
                            devices.add(Device.BLUETOOTH)
                        }
                    }
                    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                    AudioDeviceInfo.TYPE_USB_HEADSET -> {
                        if (Device.WIRED_HEADSET !in devices) devices.add(Device.WIRED_HEADSET)
                    }
                }
            }
        } else {
            devices.add(Device.EARPIECE)
            devices.add(Device.SPEAKER)

            val outputDevices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            for (d in outputDevices) {
                if (d.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                    d.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                    d.type == AudioDeviceInfo.TYPE_USB_HEADSET) {
                    if (Device.WIRED_HEADSET !in devices) devices.add(Device.WIRED_HEADSET)
                }
            }

            try {
                val btAdapter = BluetoothAdapter.getDefaultAdapter()
                if (btAdapter != null && btAdapter.isEnabled) {
                    val connectedState = btAdapter.getProfileConnectionState(BluetoothProfile.HEADSET)
                    if (connectedState == BluetoothProfile.STATE_CONNECTED) {
                        devices.add(Device.BLUETOOTH)
                    }
                }
            } catch (e: SecurityException) {
                Log.w(TAG, "BT permission not granted", e)
            }
        }

        return devices
    }

    /**
     * A route chosen by the user. Returns false — and applies nothing — when
     * the router is not running: the call has not reached start() yet or is
     * already torn down. The old silent return let the in-call toggle flip
     * to "speaker on" while the earpiece stayed live (O08). A refusal here
     * must not start the router either: setDevice outside a call would
     * otherwise put the phone in VoIP mode with no one to end it.
     */
    fun setDevice(device: Device): Boolean {
        if (!isActive) {
            Log.w(TAG, "setDevice($device) refused: router inactive")
            timeline.record("route", "$device refused: router inactive")
            return false
        }
        Log.d(TAG, "setDevice: $device (pinned)")
        synchronized(routeLock) {
            pinnedDevice = device
            setDeviceInternal(device)
        }
        notifyListener()
        return true
    }

    /**
     * Telecom switched this call's audio route.
     *
     * Telecom owns the route of a self-managed call and switches it on its own —
     * to a headset the moment one connects — so its report is what the call
     * really uses and what the UI shows. A loudspeaker the user pinned, and the
     * loudspeaker of a video call Telecom dropped onto the earpiece, are asked
     * back through [setDeviceInternal]; see [AudioRoutePolicy.onTelecomRouteChanged].
     * Reports before [start] are ignored: start picks the call's first route
     * itself and asks Telecom for it.
     */
    fun onTelecomRouteChanged(route: Device) {
        if (!isActive) return
        synchronized(routeLock) {
            val decision = AudioRoutePolicy.onTelecomRouteChanged(route, pinnedDevice, callType)
            if (!decision.keepPin) pinnedDevice = null
            val target = decision.target
            if (target != null) {
                Log.d(TAG, "Telecom moved the call to $route — asking for $target")
                timeline.record("route", "telecom moved to $route, asking for $target")
                setDeviceInternal(target)
            } else if (activeDevice != route) {
                activeDevice = route
                timeline.record("route", "telecom reports $route")
            }
        }
        notifyListener()
    }

    fun getActiveDevice(): Device = activeDevice

    fun getBluetoothDeviceName(): String? = bluetoothDeviceName

    fun getState(): AudioDeviceState {
        return AudioDeviceState(
            available = getAvailableDevices(),
            active = activeDevice
        )
    }

    private fun setDeviceInternal(device: Device) {
        activeDevice = device
        // Telecom owns the route of a self-managed call: while it held the audio
        // mode on a Samsung with Android 14, the platform ignored every
        // AudioManager request below (stage 3, 2026-09-13). Ask it first. The
        // AudioManager path stays for a call Telecom never registered and for
        // platforms that honour it; both name the same device.
        CallConnectionService.currentConnection?.let { connection ->
            val asked = connection.requestAudioRoute(device)
            timeline.record("route", "telecom $device${if (asked) "" else " refused: released"}")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            setDeviceModern(device)
        } else {
            setDeviceLegacy(device)
        }
    }

    private fun setDeviceModern(device: Device) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

        val commDevices = audioManager.availableCommunicationDevices
        val target = if (device == Device.BLUETOOTH) {
            commDevices.firstOrNull {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                it.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                it.type == AudioDeviceInfo.TYPE_BLE_SPEAKER
            }
        } else {
            val targetType = when (device) {
                Device.EARPIECE -> AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                Device.SPEAKER -> AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                Device.WIRED_HEADSET -> AudioDeviceInfo.TYPE_WIRED_HEADSET
                else -> AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            }
            commDevices.firstOrNull { it.type == targetType }
        }

        if (target != null) {
            val success = audioManager.setCommunicationDevice(target)
            timeline.record(
                "route",
                "${deviceTypeToString(target.type)}${if (success) "" else " FAILED"}",
            )
            Log.d(LIFECYCLE_TAG, "setCommunicationDevice(${deviceTypeToString(target.type)}): $success")
        } else if (shouldClearWhenTargetMissing(device)) {
            // Removable device (BT / wired) genuinely gone — fall back to the
            // system default by clearing the explicit communication device.
            Log.w(LIFECYCLE_TAG, "Removable target $device gone — clearing communication device")
            audioManager.clearCommunicationDevice()
        } else {
            // WEE-54 / forta-bugs#860: built-in earpiece/speaker missing from
            // the enumeration is a transient Android 15 timing artifact — do
            // NOT clear, or we strand the call in total silence. Keep the
            // system's current routing; the OEM mode-reapply window settles it.
            Log.w(
                LIFECYCLE_TAG,
                "Built-in target $device not yet enumerated (Android 15 race) — keeping current routing",
            )
        }

        // WEE-76 (#944/#960): reinforce the built-in earpiece/speaker route with
        // the legacy speakerphone flag. setCommunicationDevice(SPEAKER) is an
        // unreliable no-op on several OEMs (returns false under contention, or
        // the speaker is briefly un-enumerated and the guard above keeps the
        // earpiece), so an explicit speaker tap never engaged the loudspeaker for
        // many users. Mirroring isSpeakerphoneOn to the requested built-in device
        // is the reliable cross-OEM switch and matches the modern route, so it is
        // safe on healthy devices. BT/wired → null → left to the modern path.
        legacySpeakerphoneTarget(device)?.let { speakerphoneOn ->
            try {
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = speakerphoneOn
            } catch (e: Exception) {
                Log.w(LIFECYCLE_TAG, "legacy isSpeakerphoneOn=$speakerphoneOn threw", e)
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun setDeviceLegacy(device: Device) {
        timeline.record("route", "$device (legacy)")
        when (device) {
            Device.EARPIECE -> {
                audioManager.isSpeakerphoneOn = false
                if (audioManager.isBluetoothScoOn) {
                    audioManager.isBluetoothScoOn = false
                    audioManager.stopBluetoothSco()
                }
            }
            Device.SPEAKER -> {
                if (audioManager.isBluetoothScoOn) {
                    audioManager.isBluetoothScoOn = false
                    audioManager.stopBluetoothSco()
                }
                audioManager.isSpeakerphoneOn = true
            }
            Device.BLUETOOTH -> {
                audioManager.isSpeakerphoneOn = false
                audioManager.startBluetoothSco()
                audioManager.isBluetoothScoOn = true
            }
            Device.WIRED_HEADSET -> {
                audioManager.isSpeakerphoneOn = false
                if (audioManager.isBluetoothScoOn) {
                    audioManager.isBluetoothScoOn = false
                    audioManager.stopBluetoothSco()
                }
            }
        }
    }

    private fun handleDevicesChanged() {
        if (!isActive) return
        val available = getAvailableDevices()
        Log.d(TAG, "Devices changed: available=$available, active=$activeDevice, pinned=$pinnedDevice")

        synchronized(routeLock) {
            val decision = AudioRoutePolicy.onDevicesChanged(activeDevice, available.toSet(), pinnedDevice, callType)
            if (!decision.keepPin) pinnedDevice = null
            decision.target?.let { target ->
                Log.d(TAG, "Devices changed: routing to $target (pinned=$pinnedDevice)")
                timeline.record("route", "$target on devices changed")
                setDeviceInternal(target)
            }
        }

        notifyListener()
    }

    private fun notifyListener() {
        mainHandler.post {
            val state = getState()
            // Fan out to both slots. Either may be null — core is null before
            // CallPlugin has loaded (very early app boot); ui is null outside
            // an active CallActivity. Exceptions thrown by one listener must
            // not stop the other from being notified.
            coreListener?.let {
                try { it.onAudioDeviceChanged(state) } catch (e: Exception) {
                    Log.e(TAG, "coreListener threw", e)
                }
            }
            uiListener?.let {
                try { it.onAudioDeviceChanged(state) } catch (e: Exception) {
                    Log.e(TAG, "uiListener threw", e)
                }
            }
        }
    }

    private fun deviceTypeToString(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "EARPIECE"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "SPEAKER"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BT_SCO"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "WIRED_HEADPHONES"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB_HEADSET"
        else -> "UNKNOWN($type)"
    }
}
