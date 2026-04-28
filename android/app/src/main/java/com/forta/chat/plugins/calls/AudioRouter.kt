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
    private var isActive = false
    private var callType = "voice"
    private var bluetoothDeviceName: String? = null

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

        // OEM fix: Some Chinese ROMs (MIUI, RealmeUI, XOS) reset audio mode
        // asynchronously after init. Re-apply after a short delay to catch resets.
        mainHandler.postDelayed({
            if (isActive && audioManager.mode != AudioManager.MODE_IN_COMMUNICATION) {
                Log.w(LIFECYCLE_TAG, "Audio mode was reset by system — re-applying MODE_IN_COMMUNICATION")
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            }
        }, 500)

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
        } else {
            Log.w(LIFECYCLE_TAG, "Target device $device not found in available communication devices")
            audioManager.clearCommunicationDevice()
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
