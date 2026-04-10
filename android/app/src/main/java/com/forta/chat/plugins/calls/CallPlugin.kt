package com.forta.chat.plugins.calls

import android.content.Intent
import android.os.Bundle
import android.telecom.TelecomManager
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "NativeCall",
    permissions = [
        Permission(
            strings = [android.Manifest.permission.RECORD_AUDIO],
            alias = "microphone"
        )
    ]
)
class CallPlugin : Plugin() {

    companion object {
        private const val TAG = "CallPlugin"
    }

    private var audioRouter: AudioRouter? = null

    override fun load() {
        try {
            CallConnectionService.registerPhoneAccount(context)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register phone account", e)
        }

        CallConnection.onAnswered = { callId ->
            notifyListeners("callAnswered", JSObject().apply {
                put("callId", callId)
            })
        }
        CallConnection.onRejected = { callId ->
            notifyListeners("callDeclined", JSObject().apply {
                put("callId", callId)
            })
        }
        CallConnection.onEnded = { callId ->
            notifyListeners("callEnded", JSObject().apply {
                put("callId", callId)
            })
        }

        // Initialize AudioRouter for JS-side audio control
        audioRouter = AudioRouter(context)
        audioRouter?.setListener(object : AudioRouter.Listener {
            override fun onAudioDeviceChanged(state: AudioRouter.AudioDeviceState) {
                val data = JSObject().apply {
                    put("active", state.active.name.lowercase())
                    val devicesArray = org.json.JSONArray()
                    for (d in state.available) {
                        devicesArray.put(org.json.JSONObject().apply {
                            put("type", d.name.lowercase())
                            put("name", if (d == AudioRouter.Device.BLUETOOTH) {
                                audioRouter?.getBluetoothDeviceName() ?: "Bluetooth"
                            } else d.label)
                        })
                    }
                    put("devices", devicesArray)
                }
                notifyListeners("audioDevicesChanged", data)
            }
        })
    }

    @PluginMethod
    fun reportIncomingCall(call: PluginCall) {
        val callId = call.getString("callId") ?: ""
        val callerName = call.getString("callerName") ?: "Unknown"
        val roomId = call.getString("roomId") ?: ""
        val hasVideo = call.getBoolean("hasVideo", false) ?: false

        Log.d(TAG, "reportIncomingCall: $callerName ($callId)")

        try {
            val telecomManager = context.getSystemService(TelecomManager::class.java)
            val handle = CallConnectionService.getPhoneAccountHandle(context)

            val extras = Bundle().apply {
                putString("callId", callId)
                putString("callerName", callerName)
                putString("roomId", roomId)
                putBoolean("hasVideo", hasVideo)
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
            }

            telecomManager.addNewIncomingCall(handle, extras)
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to report incoming call", e)
            val intent = Intent(context, IncomingCallActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
                putExtra("callId", callId)
                putExtra("callerName", callerName)
            }
            context.startActivity(intent)
            call.resolve()
        }
    }

    @PluginMethod
    fun reportOutgoingCall(call: PluginCall) {
        val callId = call.getString("callId") ?: ""
        val callerName = call.getString("callerName") ?: ""
        val hasVideo = call.getBoolean("hasVideo", false) ?: false

        Log.d(TAG, "reportOutgoingCall: $callerName ($callId)")

        try {
            val telecomManager = context.getSystemService(TelecomManager::class.java)
            val handle = CallConnectionService.getPhoneAccountHandle(context)

            val extras = Bundle().apply {
                putString("callId", callId)
                putString("callerName", callerName)
                putBoolean("hasVideo", hasVideo)
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
            }

            telecomManager.placeCall(
                android.net.Uri.fromParts("sip", callerName, null),
                extras
            )
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to place outgoing call via TelecomManager, falling back", e)
            // Fallback: create connection directly (won't get system audio routing)
            val connection = CallConnection(context, callId)
            connection.setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
            connection.setAddress(
                android.net.Uri.fromParts("sip", callerName, null),
                TelecomManager.PRESENTATION_ALLOWED
            )
            connection.setDialing()
            CallConnectionService.currentConnection = connection
            call.resolve()
        }
    }

    @PluginMethod
    fun reportCallEnded(call: PluginCall) {
        CallConnectionService.currentConnection?.onDisconnect()
        CallConnectionService.currentConnection = null
        call.resolve()
    }

    @PluginMethod
    fun reportCallConnected(call: PluginCall) {
        CallConnectionService.currentConnection?.setActive()
        call.resolve()
    }

    @PluginMethod
    fun requestAudioPermission(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            call.resolve(JSObject().apply { put("granted", true) })
            return
        }
        requestPermissionForAlias("microphone", call, "audioPermissionCallback")
    }

    @PermissionCallback
    private fun audioPermissionCallback(call: PluginCall) {
        val granted = getPermissionState("microphone") == PermissionState.GRANTED
        Log.d(TAG, "[WebRTCAudio] requestAudioPermission callback: granted=$granted")
        call.resolve(JSObject().apply { put("granted", granted) })
    }

    @PluginMethod
    fun getAudioDevices(call: PluginCall) {
        val router = audioRouter ?: run {
            call.reject("AudioRouter not initialized")
            return
        }
        val state = router.getState()
        val result = JSObject().apply {
            put("active", state.active.name.lowercase())
            val devicesArray = org.json.JSONArray()
            for (d in state.available) {
                devicesArray.put(org.json.JSONObject().apply {
                    put("type", d.name.lowercase())
                    put("name", if (d == AudioRouter.Device.BLUETOOTH) {
                        router.getBluetoothDeviceName() ?: "Bluetooth"
                    } else d.label)
                })
            }
            put("devices", devicesArray)
        }
        call.resolve(result)
    }

    @PluginMethod
    fun setAudioDevice(call: PluginCall) {
        val type = call.getString("type") ?: run {
            call.reject("Missing type")
            return
        }
        val device = when (type.lowercase()) {
            "earpiece" -> AudioRouter.Device.EARPIECE
            "speaker" -> AudioRouter.Device.SPEAKER
            "bluetooth" -> AudioRouter.Device.BLUETOOTH
            "wired_headset" -> AudioRouter.Device.WIRED_HEADSET
            else -> {
                call.reject("Unknown device type: $type")
                return
            }
        }
        audioRouter?.setDevice(device)
        call.resolve()
    }

    @PluginMethod
    fun startAudioRouting(call: PluginCall) {
        val callType = call.getString("callType") ?: "voice"
        audioRouter?.start(callType)
        call.resolve()
    }

    @PluginMethod
    fun stopAudioRouting(call: PluginCall) {
        audioRouter?.stop()
        call.resolve()
    }
}
