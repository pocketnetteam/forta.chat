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

    fun start(callType: String) = synchronized(lifecycleLock) {
        // Idempotent: second start() in the same call cycle (e.g. JS side
        // hits startAudioRouting twice because of renegotiation) must not
        // re-register device callbacks or the same callback would fire
        // twice per device add/remove.
        // Synchronized with stop()/forceStop() so a watchdog forceStop
        // racing a fresh start() cannot interleave half-set state.
        if (isActive) {
            Log.w(LIFECYCLE_TAG, "start($callType) — already active, no-op (current callType=${this.callType})")
            return@synchronized
        }

        this.callType = callType
        this.isActive = true

        activeDevice = if (callType == "video") Device.SPEAKER else Device.EARPIECE
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
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
            setDevice(Device.BLUETOOTH)
        } else {
            setDeviceInternal(activeDevice)
        }

        Log.d(LIFECYCLE_TAG, "start($callType) complete: active=$activeDevice, available=$available")
    }

    fun stop() = synchronized(lifecycleLock) {
        // Idempotent: every call lifecycle path ends with stopAudioRouting
        // (hangup, reject, SDK state=Ended, answer-errored, permission-denied),
        // so calling stop twice happens routinely. Without the guard we would
        // unregisterAudioDeviceCallback on an already-unregistered callback
        // and log a spurious warning.
        if (!isActive) {
            Log.w(LIFECYCLE_TAG, "stop() — already inactive, no-op")
            return@synchronized
        }

        isActive = false

        // Session 54: cancel the orphan watchdog and the OEM re-apply
        // runnables before tearing down. Without these removeCallbacks,
        // a healthy hangup followed by an immediate new call would see
        // the previous call's watchdog still scheduled, and any pending
        // re-apply tick could fire after the new start() had set the mode.
        // WEE-16: the single runnable is now a list (modeReapplyScheduleMs).
        stopWatchdog?.let { mainHandler.removeCallbacks(it) }
        stopWatchdog = null
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
            } catch (e: Exception) {
                Log.w(LIFECYCLE_TAG, "setMode(MODE_NORMAL) threw", e)
            }

            try {
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = false
            } catch (_: Exception) {}

            Log.d(LIFECYCLE_TAG, "stop(): set mode=MODE_NORMAL, cleared comm device")
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
    fun forceStop() = synchronized(lifecycleLock) {
        Log.w(LIFECYCLE_TAG, "forceStop() — bypassing guards, brute reset")
        isActive = false

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

        try { audioManager.mode = AudioManager.MODE_NORMAL } catch (_: Exception) {}
        @Suppress("DEPRECATION")
        try { audioManager.isSpeakerphoneOn = false } catch (_: Exception) {}

        Log.d(LIFECYCLE_TAG, "forceStop() complete")
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

    fun setDevice(device: Device) {
        if (!isActive) return
        Log.d(TAG, "setDevice: $device")
        setDeviceInternal(device)
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
    }

    @Suppress("DEPRECATION")
    private fun setDeviceLegacy(device: Device) {
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
        Log.d(TAG, "Devices changed: available=$available, active=$activeDevice")

        if (Device.BLUETOOTH in available && activeDevice != Device.BLUETOOTH) {
            Log.d(TAG, "BT appeared, auto-switching")
            setDeviceInternal(Device.BLUETOOTH)
        } else if (activeDevice !in available) {
            val fallback = when {
                Device.WIRED_HEADSET in available -> Device.WIRED_HEADSET
                callType == "video" -> Device.SPEAKER
                else -> Device.EARPIECE
            }
            Log.d(TAG, "Active device $activeDevice gone, fallback to $fallback")
            setDeviceInternal(fallback)
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
