package com.forta.chat.plugins.push

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.forta.chat.FortaFirebaseMessagingService
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight

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

    /** Buffered push intent data for cold-start retrieval by JS. Written from
     *  the main thread (onNewIntent), read on the plugin thread: under [pendingLock]. */
    @Volatile
    private var pendingPushRoom: JSObject? = null
    private val pendingLock = Any()

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
        android.util.Log.i("FortaPush", "push tap buffered from the launch intent (roomId=$roomId)")
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
        // singleTask: with the app closed the task outlives the process, so a
        // tap recreates the activity from the launcher intent and arrives here,
        // before the page has loaded. Nobody listens yet; the tap waits for
        // getPendingIntent instead of being dropped (Samsung, 2026-10-10).
        val buffered = synchronized(pendingLock) {
            if (hasListeners("pushOpenRoom")) false else { pendingPushRoom = data; true }
        }
        if (buffered) {
            android.util.Log.i("FortaPush", "push tap buffered until JS listens (roomId=$roomId)")
            return
        }
        android.util.Log.i("FortaPush", "push tap forwarded to JS (roomId=$roomId)")
        notifyListeners("pushOpenRoom", data)
    }

    /** Called by JS to retrieve buffered push intent from cold-start */
    @PluginMethod
    fun getPendingIntent(call: PluginCall) {
        val pending = synchronized(pendingLock) {
            pendingPushRoom.also { pendingPushRoom = null }
        }
        if (pending != null) {
            call.resolve(pending)
        } else {
            call.resolve(JSObject())
        }
    }

    /** True when FCM can deliver here: google-services.json was present at build
     *  time and Google Play Services is on the device ([FcmAvailability]). */
    @PluginMethod
    fun isFcmAvailable(call: PluginCall) {
        val status = playServicesStatus()
        val result = JSObject()
        result.put("available", FcmAvailability.fcmUsable(com.forta.chat.BuildConfig.FIREBASE_ENABLED, status))
        result.put("playServices", FcmAvailability.playServicesUsable(status))
        call.resolve(result)
    }

    private fun playServicesStatus(): Int = try {
        GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context)
    } catch (_: Throwable) {
        ConnectionResult.SUCCESS // unknown: do not block registration
    }

    /** JS is signed in: pushes are delivered (see [PushSessionPolicy]). */
    @PluginMethod
    fun markSessionActive(call: PluginCall) {
        PushSessionStore.write(context, PushSessionPolicy.ACTIVE)
        call.resolve()
    }

    /** JS is logging out: from now on the FCM service drops every push. */
    @PluginMethod
    fun markLoggedOut(call: PluginCall) {
        PushSessionStore.write(context, PushSessionPolicy.LOGGED_OUT)
        call.resolve()
    }

    /** The "Incoming calls" switch (see IncomingCallsStore). */
    @PluginMethod
    fun setIncomingCallsEnabled(call: PluginCall) {
        IncomingCallsStore.write(context, call.getBoolean("enabled", true) ?: true)
        call.resolve()
    }

    /** JS reads native's copy when WebView storage lost its own (C05). */
    @PluginMethod
    fun getIncomingCallsEnabled(call: PluginCall) {
        call.resolve(JSObject().put("enabled", IncomingCallsStore.isEnabled(context)))
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

    /**
     * Cache the roomId -> isGroup map pushed from JS.
     *
     * The FCM payload carries no marker for "this message came from a group
     * chat", so without this cache the cold-start notification cannot tell a
     * group message from a direct one and ends up showing only the sender.
     * JS mirrors Dexie's `rooms.isGroup` here alongside the room names.
     */
    @PluginMethod
    fun cacheGroupRooms(call: PluginCall) {
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
            editor.putBoolean(
                FortaFirebaseMessagingService.groupRoomKey(roomId),
                rooms.optBoolean(roomId, false),
            )
        }
        editor.apply()
        call.resolve()
    }

    /** Contact aliases for notification titles (audit S6-01); replaces the whole set. */
    @PluginMethod
    fun cacheSenderAliases(call: PluginCall) {
        val aliases = call.getObject("aliases") ?: run {
            call.reject("aliases object is required"); return
        }
        val map = mutableMapOf<String, String>()
        val keys = aliases.keys()
        while (keys.hasNext()) {
            val senderId = keys.next()
            aliases.getString(senderId)?.let { map[senderId] = it }
        }
        FortaFirebaseMessagingService.replaceSenderAliases(context, map)
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
        // The room's missed-call notice sits in the messages channel too, so
        // the launcher badge counts it until the room is opened.
        nm.cancel(FortaFirebaseMessagingService.MISSED_CALL_TAG, FortaFirebaseMessagingService.missedCallSlot(roomId))
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
                if (sb.id == targetId && isMessagesChannel(sb.notification)) {
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
            if (sb.tag == FortaFirebaseMessagingService.NOTIF_TAG && isMessagesChannel(sb.notification)) {
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

    /**
     * O10: whether Android still lets this app raise the full-screen
     * incoming-call surface. Android 14 revokes USE_FULL_SCREEN_INTENT for
     * apps installed from outside the store, and the ringer silently degrades
     * to a heads-up card. `manageable` says a system screen exists to grant
     * it (API 34+); before that the permission is a plain manifest grant.
     */
    @PluginMethod
    fun getFullScreenIntentStatus(call: PluginCall) {
        val manageable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        val allowed = if (manageable) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.canUseFullScreenIntent()
        } else {
            true
        }
        call.resolve(JSObject().apply {
            put("allowed", allowed)
            put("manageable", manageable)
        })
    }

    /** Deep-link into the system screen that grants the full-screen intent (API 34+). */
    @PluginMethod
    fun openFullScreenIntentSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            call.reject("Full-screen intent settings exist from Android 14", "unsupported")
            return
        }
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                Uri.parse("package:${context.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Could not open the full-screen intent settings: ${e.message}", "unavailable", e)
        }
    }

    /**
     * Missed push calls (T3): does Android exempt this app from battery
     * optimization? Without the exemption Doze and App Standby can hold a call
     * push back until the invite is over.
     */
    @PluginMethod
    fun getBatteryOptimizationStatus(call: PluginCall) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        call.resolve(JSObject().apply {
            put("ignoring", pm.isIgnoringBatteryOptimizations(context.packageName))
        })
    }

    /**
     * Ask the user to exempt the app: the system dialog decides, the app never
     * changes the setting itself. Builds without that dialog get the list of
     * apps instead.
     */
    @PluginMethod
    fun requestIgnoreBatteryOptimizations(call: PluginCall) {
        try {
            context.startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${context.packageName}"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            call.resolve()
        } catch (e: Exception) {
            try {
                context.startActivity(
                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                call.resolve()
            } catch (fallback: Exception) {
                call.reject("Could not open the battery optimization settings: ${fallback.message}", "unavailable", fallback)
            }
        }
    }

    /** Channels exist from Android 8; below it every notification is the app's one stream. */
    private fun isMessagesChannel(n: android.app.Notification?): Boolean {
        if (n == null) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return n.channelId == FortaFirebaseMessagingService.CHANNEL_MESSAGES
    }
}
