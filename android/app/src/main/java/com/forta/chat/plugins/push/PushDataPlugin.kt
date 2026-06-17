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

    companion object {
        private const val INTENT_PREFS = "forta_push_intents"
        private const val KEY_CONSUMED = "consumed_push_keys"
        private const val MAX_CONSUMED_KEYS = 20
    }

    /** Buffered push intent data for cold-start retrieval by JS */
    private var pendingPushRoom: JSObject? = null

    override fun load() {
        // Register with FCM service so it can forward push data to us
        FortaFirebaseMessagingService.pluginInstance = this

        // Buffer push intent for cold-start (JS listeners aren't ready yet)
        activity?.intent?.let { bufferPushIntent(it) }
    }

    // ── Stale-intent guards (WEE-82 / forta-bugs#962) ────────────────────────
    //
    // `intent.removeExtra()` below only mutates the in-memory Intent. Android
    // keeps the ORIGINAL launch intent in the task record: when the process is
    // killed in background (e.g. memory pressure while the user watched a
    // video) and the task is re-entered, the activity is recreated with the
    // push extras present again — and we'd re-open a chat the user tapped into
    // days ago instead of leaving them where they were. Two guards:
    //   1. FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY — relaunch via recents is never
    //      a fresh notification tap.
    //   2. A persisted LRU of consumed (roomId|eventId) keys — covers
    //      recreation paths that don't set the history flag. Event IDs are
    //      unique per message, so a fresh tap is never falsely skipped; null
    //      eventId intents skip this check (room-only key could swallow a
    //      legitimate second tap for the same room).

    private fun intentKey(roomId: String, eventId: String?): String? =
        eventId?.let { "$roomId|$it" }

    private fun consumedKeys(): List<String> =
        context.getSharedPreferences(INTENT_PREFS, android.content.Context.MODE_PRIVATE)
            .getString(KEY_CONSUMED, "")
            ?.split('\n')
            ?.filter { it.isNotEmpty() }
            ?: emptyList()

    private fun markConsumed(key: String?) {
        if (key == null) return
        val keys = (consumedKeys().filter { it != key } + key).takeLast(MAX_CONSUMED_KEYS)
        context.getSharedPreferences(INTENT_PREFS, android.content.Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CONSUMED, keys.joinToString("\n"))
            .apply()
    }

    /** True when this intent must not navigate (historical relaunch or already handled). */
    private fun isStalePushIntent(intent: Intent, roomId: String, eventId: String?): Boolean {
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return true
        val key = intentKey(roomId, eventId) ?: return false
        return consumedKeys().contains(key)
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

        if (isStalePushIntent(intent, roomId, eventId)) {
            android.util.Log.d("FortaPush", "bufferPushIntent: stale push intent skipped (roomId=$roomId)")
            return
        }
        markConsumed(intentKey(roomId, eventId))

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

        if (isStalePushIntent(intent, roomId, eventId)) {
            android.util.Log.d("FortaPush", "forwardPushIntent: stale push intent skipped (roomId=$roomId)")
            return
        }
        markConsumed(intentKey(roomId, eventId))

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
        // WEE-44 / forta-bugs#764: also cancel any orphan notifications for this
        // room. Some OEM launchers (Samsung One UI in particular) keep the badge
        // dot lit if ANY notification with this notification id is active in
        // any channel — including stale summary notifications posted before a
        // channel migration. We iterate active notifications and dismiss every
        // entry matching the messages channel for this roomId.hashCode().
        val targetId = roomId.hashCode()
        try {
            val active = nm.activeNotifications ?: emptyArray()
            for (sb in active) {
                if (sb.id == targetId && sb.notification?.channelId == FortaFirebaseMessagingService.CHANNEL_MESSAGES) {
                    nm.cancel(sb.tag, sb.id)
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("FortaPush", "cancelNotification sweep failed: $e")
        }
        android.util.Log.d("FortaPush", "cancelNotification(roomId=$roomId, id=$targetId)")
        call.resolve()
    }

    /**
     * Cancel all message notifications in the messages channel. Called by JS
     * on app resume after the user has demonstrably seen the unread state
     * (e.g. opened the chat list). The badge on the launcher icon is the
     * count of active notifications in the messages channel, so cancelling
     * here is sufficient to clear the stuck-badge case from forta-bugs#764
     * without adding ShortcutBadger or a per-launcher badge SDK.
     *
     * Call notifications (separate channel) are intentionally untouched —
     * dismissing an in-progress ringer here would be a regression.
     */
    @PluginMethod
    fun cancelAllMessageNotifications(call: PluginCall) {
        val nm = context.getSystemService(android.content.Context.NOTIFICATION_SERVICE)
            as android.app.NotificationManager
        // Cancel by tag: only the messages tag, leave call notifications alone.
        val active = nm.activeNotifications ?: emptyArray()
        for (sb in active) {
            if (sb.tag == FortaFirebaseMessagingService.NOTIF_TAG &&
                sb.notification?.channelId == FortaFirebaseMessagingService.CHANNEL_MESSAGES) {
                nm.cancel(sb.tag, sb.id)
            }
        }
        call.resolve()
    }

    /**
     * Return device manufacturer + model so JS can surface vendor-specific
     * energy-saver hints (Samsung One UI, HONOR/Huawei EMUI, Xiaomi MIUI,
     * OPPO/OnePlus ColorOS — see forta-bugs#732 and #766). Avoids adding the
     * @capacitor/device package for one Build field.
     */
    @PluginMethod
    fun getDeviceManufacturer(call: PluginCall) {
        val result = JSObject()
        result.put("manufacturer", android.os.Build.MANUFACTURER ?: "")
        result.put("model", android.os.Build.MODEL ?: "")
        result.put("sdk", android.os.Build.VERSION.SDK_INT)
        call.resolve(result)
    }

    /**
     * WEE-75 / forta-bugs#942: deep-link into the OS notification settings
     * for this app. On Android O+ the per-channel sound/vibration controls
     * live in the system UI (the channel is immutable from app code), so
     * this is the honest "manage notification sound" surface. On MIUI and
     * similar OEMs this is also where the user can re-enable a sound the
     * system muted. Falls back to the app-details screen on pre-O / when the
     * notification-settings intent can't be resolved.
     */
    @PluginMethod
    fun openNotificationSettings(call: PluginCall) {
        val ctx = context
        val intents = buildList {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                add(
                    Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                    }
                )
            }
            add(
                Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = android.net.Uri.fromParts("package", ctx.packageName, null)
                }
            )
        }
        for (intent in intents) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                ctx.startActivity(intent)
                call.resolve()
                return
            } catch (e: Exception) {
                android.util.Log.w("FortaPush", "openNotificationSettings: intent failed, trying fallback", e)
            }
        }
        call.reject("No settings activity could be opened")
    }
}
