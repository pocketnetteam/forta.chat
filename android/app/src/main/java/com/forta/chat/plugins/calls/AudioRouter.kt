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
 * - Notifies listeners on device changes for UI updates
 */
class AudioRouter(private val context: Context) {

    companion object {
        private const val TAG = "AudioRouter"
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
    private var listener: Listener? = null
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

    fun start(callType: String) {
        this.callType = callType
        this.isActive = true

        activeDevice = if (callType == "video") Device.SPEAKER else Device.EARPIECE
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION

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

        Log.d(TAG, "Started for $callType call, active=$activeDevice, available=$available")
    }

    fun stop() {
        isActive = false
        audioManager.unregisterAudioDeviceCallback(deviceCallback)

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            try {
                context.unregisterReceiver(btScoReceiver)
            } catch (_: Exception) {}

            if (audioManager.isBluetoothScoOn) {
                audioManager.isBluetoothScoOn = false
                audioManager.stopBluetoothSco()
            }
        } else {
            audioManager.clearCommunicationDevice()
        }

        audioManager.mode = AudioManager.MODE_NORMAL
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn = false
        Log.d(TAG, "Stopped")
    }

    fun setListener(listener: Listener?) {
        this.listener = listener
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
            Log.d(TAG, "setCommunicationDevice(${deviceTypeToString(target.type)}): $success")
        } else {
            Log.w(TAG, "Target device $device not found in available communication devices")
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
            listener?.onAudioDeviceChanged(getState())
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
