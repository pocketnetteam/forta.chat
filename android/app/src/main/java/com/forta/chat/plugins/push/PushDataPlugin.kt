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

    /**
     * Replace notification content while keeping the same native PendingIntent.
     * This ensures tap always goes through the native intent path (bufferPushIntent / forwardPushIntent)
     * instead of Capacitor's LocalNotifications path which can lose events on cold-start.
     */
    @PluginMethod
    fun replaceNotificationContent(call: PluginCall) {
        val roomId = call.getString("roomId") ?: run {
            call.reject("roomId is required"); return
        }
        val title = call.getString("title") ?: run {
            call.reject("title is required"); return
        }
        val body = call.getString("body") ?: run {
            call.reject("body is required"); return
        }
        val eventId = call.getString("eventId")

        val intent = android.content.Intent(context, com.forta.chat.MainActivity::class.java).apply {
            putExtra(FortaFirebaseMessagingService.EXTRA_PUSH_ROOM_ID, roomId)
            if (eventId != null) putExtra(FortaFirebaseMessagingService.EXTRA_PUSH_EVENT_ID, eventId)
            flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        val pendingIntent = android.app.PendingIntent.getActivity(
            context, roomId.hashCode(), intent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )

        val notification = androidx.core.app.NotificationCompat.Builder(context, FortaFirebaseMessagingService.CHANNEL_MESSAGES)
            .setSmallIcon(com.forta.chat.R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
            .setCategory(androidx.core.app.NotificationCompat.CATEGORY_MESSAGE)
            .setSilent(true) // Don't re-alert — just update content
            .build()

        val nm = context.getSystemService(android.content.Context.NOTIFICATION_SERVICE)
            as android.app.NotificationManager
        nm.notify(FortaFirebaseMessagingService.NOTIF_TAG, roomId.hashCode(), notification)
        call.resolve()
    }

    @PluginMethod
    fun cacheSenderNames(call: PluginCall) {
        val senders = call.getObject("senders") ?: run {
            call.reject("senders object is required"); return
        }
        val prefs = context.getSharedPreferences(
            FortaFirebaseMessagingService.PREFS_NAME,
            android.content.Context.MODE_PRIVATE
        )
        val editor = prefs.edit()
        val keys = senders.keys()
        while (keys.hasNext()) {
            val senderId = keys.next()
            val name = senders.getString(senderId)
            if (name != null) {
                editor.putString("sender_name_$senderId", name)
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
