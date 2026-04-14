package com.forta.chat.plugins.calls

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.*
import android.util.Log
import androidx.core.app.NotificationCompat
import com.forta.chat.R

class CallConnectionService : ConnectionService() {

    companion object {
        private const val TAG = "CallConnectionService"
        const val INCOMING_CALL_NOTIFICATION_ID = 9999
        var currentConnection: CallConnection? = null

        fun getPhoneAccountHandle(context: Context): PhoneAccountHandle {
            val componentName = ComponentName(context, CallConnectionService::class.java)
            return PhoneAccountHandle(componentName, "BastyonChat")
        }

        fun registerPhoneAccount(context: Context) {
            val handle = getPhoneAccountHandle(context)
            val account = PhoneAccount.builder(handle, "Bastyon Chat")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .build()
            val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
            telecomManager.registerPhoneAccount(account)
        }

        fun dismissIncomingCallNotification(context: Context) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(INCOMING_CALL_NOTIFICATION_ID)
        }
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val callId = extras.getString("callId", "")
        val callerName = extras.getString("callerName", "Unknown")
        val hasVideo = extras.getBoolean("hasVideo", false)

        Log.d(TAG, "onCreateIncomingConnection: callId=$callId, caller=$callerName")

        val connection = CallConnection(applicationContext, callId)
        connection.setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
        connection.setAddress(
            Uri.fromParts("sip", callerName, null),
            TelecomManager.PRESENTATION_ALLOWED
        )
        connection.setInitializing()
        connection.setRinging()

        currentConnection = connection

        // Show native incoming call UI
        showIncomingCallUI(callId, callerName, hasVideo)

        return connection
    }

    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val callId = extras.getString("callId", "")
        val callerName = extras.getString("callerName", "")

        Log.d(TAG, "onCreateOutgoingConnection: callId=$callId, callee=$callerName")

        val connection = CallConnection(applicationContext, callId)
        connection.setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
        connection.setAddress(
            request?.address ?: Uri.fromParts("sip", callerName, null),
            TelecomManager.PRESENTATION_ALLOWED
        )
        connection.setDialing()

        currentConnection = connection
        return connection
    }

    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        Log.e(TAG, "onCreateIncomingConnectionFailed")
    }

    override fun onCreateOutgoingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        Log.e(TAG, "onCreateOutgoingConnectionFailed")
    }

    private fun showIncomingCallUI(callId: String, callerName: String, hasVideo: Boolean) {
        val fullScreenIntent = Intent(applicationContext, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("callId", callId)
            putExtra("callerName", callerName)
            putExtra("hasVideo", hasVideo)
        }

        val fullScreenPendingIntent = PendingIntent.getActivity(
            applicationContext, 0, fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Accept action
        val acceptIntent = Intent(applicationContext, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra("callId", callId)
            putExtra("callerName", callerName)
            putExtra("action", "accept")
        }
        val acceptPendingIntent = PendingIntent.getActivity(
            applicationContext, 1, acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Decline action
        val declineIntent = Intent(applicationContext, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra("callId", callId)
            putExtra("callerName", callerName)
            putExtra("action", "decline")
        }
        val declinePendingIntent = PendingIntent.getActivity(
            applicationContext, 2, declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Create notification channel
        val channelId = "incoming_calls"
        val notificationManager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            channelId, applicationContext.getString(R.string.channel_incoming_calls),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = applicationContext.getString(R.string.channel_incoming_calls_desc)
            setSound(null, null)
        }
        notificationManager.createNotificationChannel(channel)

        // FSI permission check for Android 14+ (USE_FULL_SCREEN_INTENT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            if (!notificationManager.canUseFullScreenIntent()) {
                Log.w(TAG, "USE_FULL_SCREEN_INTENT not granted, FSI will be heads-up only")
                try {
                    applicationContext.startActivity(fullScreenIntent)
                    return
                } catch (e: Exception) {
                    Log.w(TAG, "Direct activity start also failed, falling back to notification", e)
                }
            }
        }

        val caller = androidx.core.app.Person.Builder()
            .setName(callerName)
            .setImportant(true)
            .build()

        val builder = NotificationCompat.Builder(applicationContext, channelId)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setOngoing(true)
            .setAutoCancel(false)

        // Use CallStyle on Android 12+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    caller, declinePendingIntent, acceptPendingIntent
                )
            )
        } else {
            builder.setContentTitle(applicationContext.getString(R.string.push_incoming_call))
            builder.setContentText(callerName)
        }

        notificationManager.notify(INCOMING_CALL_NOTIFICATION_ID, builder.build())

        // Start activity directly for foreground case
        try {
            applicationContext.startActivity(fullScreenIntent)
        } catch (e: Exception) {
            Log.w(TAG, "Could not start IncomingCallActivity directly", e)
        }
    }
}

class CallConnection(
    private val context: Context,
    val callId: String
) : Connection() {

    companion object {
        var onAnswered: ((String) -> Unit)? = null
        var onRejected: ((String) -> Unit)? = null
        var onEnded: ((String) -> Unit)? = null

        /**
         * Queued answer callId — set when user taps "Answer" before JS listener
         * is wired. JS side checks and replays this on wire().
         */
        var pendingAnswerCallId: String? = null
    }

    override fun onAnswer() {
        Log.d("CallConnection", "onAnswer: $callId")
        setActive()
        CallConnectionService.dismissIncomingCallNotification(context)
        if (onAnswered != null) {
            onAnswered?.invoke(callId)
        } else {
            // JS not ready yet — queue for replay
            Log.w("CallConnection", "onAnswer: JS listener not wired, queuing callId=$callId")
            pendingAnswerCallId = callId
        }
    }

    override fun onReject() {
        Log.d("CallConnection", "onReject: $callId")
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        destroy()
        CallConnectionService.dismissIncomingCallNotification(context)
        onRejected?.invoke(callId)
    }

    override fun onDisconnect() {
        Log.d("CallConnection", "onDisconnect: $callId")
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
        CallConnectionService.dismissIncomingCallNotification(context)
        onEnded?.invoke(callId)
    }
}
