package com.forta.chat.plugins.push

import android.content.Intent
import com.forta.chat.FortaFirebaseMessagingService
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Bridges push data between native FCM service and JS:
 * - Receives forwarded push data from FortaFirebaseMessagingService
 * - Caches room names in SharedPreferences for native display
 * - Forwards push tap intents to JS for navigation
 */
@CapacitorPlugin(name = "PushData")
class PushDataPlugin : Plugin() {

    /** Buffered push intent data for cold-start retrieval by JS */
    private var pendingPushRoom: JSObject? = null

    override fun load() {
        // Register with FCM service so it can forward push data to us
        FortaFirebaseMessagingService.pluginInstance = this

        // Buffer push intent for cold-start (JS listeners aren't ready yet)
        activity?.intent?.let { bufferPushIntent(it) }
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        if (FortaFirebaseMessagingService.pluginInstance === this) {
            FortaFirebaseMessagingService.pluginInstance = null
        }
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        forwardPushIntent(intent)
    }

    /** Called by FortaFirebaseMessagingService to forward push data to JS */
    fun forwardPushData(data: Map<String, String>) {
        val jsData = JSObject()
        for ((key, value) in data) {
            jsData.put(key, value)
        }
        notifyListeners("pushReceived", jsData)
    }

    /** Extract push data from intent and buffer it (for cold-start before JS is ready) */
    private fun bufferPushIntent(intent: Intent) {
        val roomId = intent.getStringExtra(FortaFirebaseMessagingService.EXTRA_PUSH_ROOM_ID)
            ?: return
        val eventId = intent.getStringExtra(FortaFirebaseMessagingService.EXTRA_PUSH_EVENT_ID)
        // Clear to avoid re-firing
        intent.removeExtra(FortaFirebaseMessagingService.EXTRA_PUSH_ROOM_ID)
        intent.removeExtra(FortaFirebaseMessagingService.EXTRA_PUSH_EVENT_ID)

        val data = JSObject()
        data.put("roomId", roomId)
        if (eventId != null) data.put("eventId", eventId)
        pendingPushRoom = data
    }

    /** Extract push data from intent and notify JS immediately (app already running) */
    private fun forwardPushIntent(intent: Intent) {
        val roomId = intent.getStringExtra(FortaFirebaseMessagingService.EXTRA_PUSH_ROOM_ID)
            ?: return
        val eventId = intent.getStringExtra(FortaFirebaseMessagingService.EXTRA_PUSH_EVENT_ID)
        // Clear to avoid re-firing
        intent.removeExtra(FortaFirebaseMessagingService.EXTRA_PUSH_ROOM_ID)
        intent.removeExtra(FortaFirebaseMessagingService.EXTRA_PUSH_EVENT_ID)

        val data = JSObject()
        data.put("roomId", roomId)
        if (eventId != null) data.put("eventId", eventId)
        notifyListeners("pushOpenRoom", data)
    }

    /** Called by JS to retrieve buffered push intent from cold-start */
    @PluginMethod
    fun getPendingIntent(call: PluginCall) {
        val pending = pendingPushRoom
        pendingPushRoom = null
        if (pending != null) {
            call.resolve(pending)
        } else {
            call.resolve(JSObject())
        }
    }

    @PluginMethod
    fun cacheRoomName(call: PluginCall) {
        val roomId = call.getString("roomId") ?: run {
            call.reject("roomId is required"); return
        }
        val name = call.getString("name") ?: run {
            call.reject("name is required"); return
        }
        FortaFirebaseMessagingService.cacheRoomName(context, roomId, name)
        call.resolve()
    }

    @PluginMethod
    fun cacheRoomNames(call: PluginCall) {
        val rooms = call.getObject("rooms") ?: run {
            call.reject("rooms object is required"); return
        }
        val prefs = context.getSharedPreferences(
            FortaFirebaseMessagingService.PREFS_NAME,
            android.content.Context.MODE_PRIVATE
        )
        val editor = prefs.edit()
        val keys = rooms.keys()
        while (keys.hasNext()) {
            val roomId = keys.next()
            val name = rooms.getString(roomId)
            if (name != null) {
                editor.putString("room_name_$roomId", name)
            }
        }
        editor.apply()
        call.resolve()
    }

    @PluginMethod
    fun cancelNotification(call: PluginCall) {
        val roomId = call.getString("roomId") ?: run {
            call.reject("roomId is required"); return
        }
        val nm = context.getSystemService(android.content.Context.NOTIFICATION_SERVICE)
            as android.app.NotificationManager
        nm.cancel(FortaFirebaseMessagingService.NOTIF_TAG, roomId.hashCode())
        call.resolve()
    }
}
