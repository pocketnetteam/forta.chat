package com.forta.chat.plugins.calls

/**
 * Pure data + constants for the incoming-call notification channel.
 *
 * The runtime channel object is [android.app.NotificationChannel], which is
 * Android-framework-only and cannot be instantiated in pure JVM unit tests.
 * Extracting the spec into a plain Kotlin data class lets us regression-test
 * the values that matter (importance, ringtone, lockscreen visibility, DND
 * bypass) without pulling in Robolectric.
 *
 * Production callers build a [android.app.NotificationChannel] from this
 * spec; the spec is the source of truth.
 */
data class IncomingCallChannelSpec(
    val id: String,
    val name: String,
    val description: String,
    /** [android.app.NotificationManager.IMPORTANCE_MAX] (= 5) */
    val importance: Int,
    /** Whether to attach the system default ringtone (TYPE_RINGTONE). */
    val withRingtone: Boolean,
    val withVibration: Boolean,
    /** [android.app.Notification.VISIBILITY_PUBLIC] (= 1) */
    val lockscreenVisibility: Int,
    /** Whether the channel can interrupt Do-Not-Disturb. */
    val bypassDnd: Boolean,
)

object CallNotificationConfig {

    /**
     * Active channel id for incoming-call ringer notifications.
     *
     * Bumped from "calls" because [android.app.NotificationChannel]
     * settings are immutable after the channel is first created on the
     * device. Forta v1.x shipped a "calls" channel without an explicit
     * ringtone, and once a Xiaomi MIUI user had the channel created
     * silent (or muted it manually), no app-side `setSound(...)` could
     * resurrect the ring (forta-bugs#768).
     *
     * Creating a fresh channel id forces Android to apply the new
     * settings exactly once, after which users keep full control over
     * their own customizations.
     */
    const val INCOMING_CALL_CHANNEL_ID = "incoming_call_v2"

    /**
     * Legacy ids we explicitly delete on FCM service start. Without
     * deletion the old "calls" channel keeps showing in the per-app
     * notification settings even though no notifications are posted to
     * it any longer — clutter that users have flagged on the bug board.
     */
    val LEGACY_INCOMING_CALL_CHANNEL_IDS: List<String> = listOf("calls")

    fun incomingCallChannelSpec(name: String, description: String): IncomingCallChannelSpec =
        IncomingCallChannelSpec(
            id = INCOMING_CALL_CHANNEL_ID,
            name = name,
            description = description,
            // NotificationManager.IMPORTANCE_MAX
            importance = 5,
            withRingtone = true,
            withVibration = true,
            // Notification.VISIBILITY_PUBLIC — show on lock screen with full content
            lockscreenVisibility = 1,
            bypassDnd = true,
        )
}
