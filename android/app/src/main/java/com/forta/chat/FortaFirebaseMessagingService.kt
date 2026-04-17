package com.forta.chat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.telecom.TelecomManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.forta.chat.plugins.calls.CallConnectionService
import com.forta.chat.plugins.calls.IncomingCallActivity
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Native FCM handler — receives ALL push messages (data-only).
 *
 * Flow:
 * 1. Always show a notification immediately (room name from cache + preview by type)
 * 2. Forward push data to JS via PushDataPlugin (if WebView is alive)
 * 3. JS can then decrypt the message and REPLACE the notification with full text
 */
class FortaFirebaseMessagingService : FirebaseMessagingService() {

    override fun onCreate() {
        super.onCreate()
        ensureChannels()
    }

    /** Create notification channels eagerly so they exist even when JS hasn't started */
    private fun ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return

        if (nm.getNotificationChannel(CHANNEL_MESSAGES) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_MESSAGES, getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = getString(R.string.channel_messages_desc)
                    enableVibration(true)
                }
            )
        }
        if (nm.getNotificationChannel(CHANNEL_CALLS) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_CALLS, getString(R.string.channel_calls), NotificationManager.IMPORTANCE_MAX).apply {
                    description = getString(R.string.channel_calls_desc)
                    enableVibration(true)
                    setSound(
                        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                        android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .build()
                    )
                }
            )
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        Log.d(TAG, "Push received: room_id=${data["room_id"]}, event_id=${data["event_id"]}, " +
            "sender=${data["sender"]}, sender_display_name=${data["sender_display_name"]}, " +
            "room_name=${data["room_name"]}, msg_type=${data["msg_type"]}, " +
            "content_msgtype=${data["content_msgtype"]}")

        val roomId = data["room_id"] ?: return
        val eventId = data["event_id"]
        val msgType = data["msg_type"] ?: ""
        val contentMsgtype = data["content_msgtype"]
        val sender = data["sender"]
        val senderName = data["sender_display_name"]
        val roomName = data["room_name"]

        // Cache room name if provided
        if (roomName != null) {
            cacheRoomName(this, roomId, roomName)
        }

        // Cache sender display name if provided (for future offline lookups)
        if (senderName != null && sender != null) {
            cacheSenderName(this, sender, senderName)
        }

        // Handle call cancel paths — full cleanup of incoming-call UI state.
        //
        // Three ways an incoming call can end before we answer:
        //   m.call.hangup        — caller cancelled
        //   m.call.reject        — we (or another device of ours) rejected
        //   m.call.select_answer — another of our devices answered
        //
        // For all three we must tear down BOTH surfaces:
        //   1. IncomingCallActivity (full-screen ringer)
        //   2. CallConnectionService notification in the shade
        //      + its Telecom `currentConnection`, or the shade keeps
        //        pulling the ringer back every time the user drags down.
        //
        // Without this, users saw the notification persist after the
        // caller had long given up — the JS side received the Matrix
        // event but had no hook into the native notification stack.
        if (msgType == "m.call.hangup" || msgType == "m.call.reject" ||
            msgType == "m.call.select_answer") {
            Log.d(TAG, "Call ended remotely (type=$msgType), tearing down incoming UI")
            IncomingCallActivity.dismissIfShowing()
            com.forta.chat.plugins.calls.CallConnectionService.dismissIncomingCallNotification(this)
            try {
                com.forta.chat.plugins.calls.CallConnectionService.currentConnection
                    ?.onDisconnect()
                com.forta.chat.plugins.calls.CallConnectionService.currentConnection = null
            } catch (e: Exception) {
                Log.w(TAG, "Failed to disconnect currentConnection", e)
            }
            // End-of-call signal also clears the dedup marker so a
            // genuinely new invite (new call_id) can ring again.
            val endedCallId = data["call_id"] ?: data["event_id"]
            if (endedCallId != null && lastRingingCallId == endedCallId) {
                lastRingingCallId = null
            }
            forwardToJs(data)
            return
        }

        // Handle calls
        if (msgType == "m.call.invite") {
            // Suppress invite retries for a call we're already ringing
            // or answering. Caller clients resend m.call.invite every
            // few seconds until they see our answer/hangup; each retry
            // arrives as a fresh push with the same call_id but a new
            // event_id. Without this guard each retry stacks another
            // ringer on top of the one the user is already looking at.
            val callId = data["call_id"] ?: data["event_id"] ?: ""
            if (callId.isNotEmpty() && callId == lastRingingCallId) {
                Log.d(TAG, "Duplicate invite retry for $callId — suppressing")
                forwardToJs(data)
                return
            }
            lastRingingCallId = callId.takeIf { it.isNotEmpty() }

            // Cancel any existing message notification for this room
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIF_TAG, roomId.hashCode())
            showCallNotification(roomId, senderName ?: getCachedRoomName(roomId) ?: "Forta Chat", data)
            forwardToJs(data)
            return
        }

        // Build notification text — fallback chain for best possible title
        val title = senderName
            ?: (sender?.let { getCachedSenderName(it) })
            ?: roomName
            ?: getCachedRoomName(roomId)
            ?: getString(R.string.push_new_message)
        val body = previewByMsgtype(contentMsgtype)

        // Show notification (JS may replace it later with decrypted content)
        showMessageNotification(roomId, eventId, title, body)

        // Forward to JS for decryption
        forwardToJs(data)
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "New FCM token: ${token.take(20)}...")
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString("fcm_token", token)
            .apply()
    }

    private fun previewByMsgtype(msgtype: String?): String {
        return when (msgtype) {
            "m.image" -> getString(R.string.push_photo)
            "m.video" -> getString(R.string.push_video)
            "m.audio" -> getString(R.string.push_voice_message)
            "m.file" -> getString(R.string.push_file)
            else -> getString(R.string.push_new_message)
        }
    }

    private fun getCachedRoomName(roomId: String): String? {
        return getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString("room_name_$roomId", null)
    }

    private fun getCachedSenderName(sender: String): String? {
        return getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString("sender_name_$sender", null)
    }

    private fun showMessageNotification(roomId: String, eventId: String?, title: String, body: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            putExtra(EXTRA_PUSH_ROOM_ID, roomId)
            if (eventId != null) putExtra(EXTRA_PUSH_EVENT_ID, eventId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        val pendingIntent = PendingIntent.getActivity(
            this, roomId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Use room_id hashCode as notification ID so JS can replace it
        nm.notify(NOTIF_TAG, roomId.hashCode(), notification)
    }

    private fun showCallNotification(roomId: String, callerName: String, data: Map<String, String>) {
        val callId = data["call_id"] ?: data["event_id"] ?: ""

        // Always show IncomingCallActivity directly — TelecomManager often rejects self-managed calls
        try {
            val intent = Intent(this, com.forta.chat.plugins.calls.IncomingCallActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("callId", callId)
                putExtra("callerName", callerName)
                putExtra("roomId", roomId)
                putExtra("hasVideo", false)
            }
            startActivity(intent)
            Log.d(TAG, "Started IncomingCallActivity for $callerName")
        } catch (e: Exception) {
            Log.w(TAG, "Could not start IncomingCallActivity: $e")
            showSimpleCallNotification(roomId, callerName)
        }

        // Also try TelecomManager for system integration (call log, Bluetooth headset, etc.)
        try {
            CallConnectionService.registerPhoneAccount(this)
            val telecomManager = getSystemService(TelecomManager::class.java)
            val handle = CallConnectionService.getPhoneAccountHandle(this)
            val extras = Bundle().apply {
                putString("callId", callId)
                putString("callerName", callerName)
                putString("roomId", roomId)
                putBoolean("hasVideo", false)
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
            }
            telecomManager.addNewIncomingCall(handle, extras)
        } catch (e: Exception) {
            Log.w(TAG, "TelecomManager integration failed (non-critical): $e")
        }
    }

    private fun showSimpleCallNotification(roomId: String, callerName: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            putExtra(EXTRA_PUSH_ROOM_ID, roomId)
            putExtra("push_call", true)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, "call_$roomId".hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(callerName)
            .setContentText(getString(R.string.push_incoming_call))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(pendingIntent, true)
            .setOngoing(true)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_TAG, "call_$roomId".hashCode(), notification)
    }

    /** Forward push data to JS via PushDataPlugin if WebView is alive */
    private fun forwardToJs(data: Map<String, String>) {
        try {
            val plugin = pluginInstance
            if (plugin != null) {
                plugin.forwardPushData(data)
                Log.d(TAG, "Forwarded push to JS")
            } else {
                Log.d(TAG, "WebView not alive, skipping JS forward")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to forward to JS: $e")
        }
    }

    companion object {
        private const val TAG = "FortaPush"
        const val PREFS_NAME = "forta_push"
        const val CHANNEL_MESSAGES = "messages"
        const val CHANNEL_CALLS = "calls"
        const val NOTIF_TAG = "forta_push"
        const val EXTRA_PUSH_ROOM_ID = "push_room_id"
        const val EXTRA_PUSH_EVENT_ID = "push_event_id"

        // PushDataPlugin registers itself here so we can forward data
        var pluginInstance: com.forta.chat.plugins.push.PushDataPlugin? = null

        /**
         * Deduplicate call pushes by call_id.
         *
         * Caller clients retry m.call.invite (different event_id, same
         * call_id) while they wait for us to answer, so the same logical
         * ring arrives as multiple pushes. Without dedup each retry
         * triggers another IncomingCallActivity + another Telecom
         * incoming connection — stacking ringers on top of the call the
         * user has already accepted.
         *
         * We remember the last call_id handled as a ring and suppress
         * any further invite for it until we see a hangup/reject/
         * select_answer for the same id (or the process dies).
         */
        private var lastRingingCallId: String? = null

        fun cacheRoomName(context: Context, roomId: String, name: String) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString("room_name_$roomId", name)
                .apply()
        }

        fun cacheSenderName(context: Context, sender: String, name: String) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString("sender_name_$sender", name)
                .apply()
        }
    }
}
