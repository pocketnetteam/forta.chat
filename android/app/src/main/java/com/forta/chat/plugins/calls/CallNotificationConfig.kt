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

    /**
     * Mirror of [android.media.AudioManager.RINGER_MODE_NORMAL] (= 2),
     * duplicated as a plain constant so [ringVolumeToForce] stays a pure
     * JVM-unit-testable predicate without the Android framework on the
     * test classpath (same approach as [AudioRouter]'s companion predicates).
     */
    const val RINGER_MODE_NORMAL = 2

    /**
     * Compute the STREAM_RING volume to force before playing the incoming-call
     * ringtone, or `null` when no adjustment should be made.
     *
     * WEE-54 / forta-bugs#862: on MIUI / HyperOS (Xiaomi) the STREAM_RING
     * volume is frequently left muted or near-zero by the OEM even though the
     * phone is in the normal ringer mode, so [android.media.RingtoneManager]
     * plays inaudibly and the user only feels the vibration ("тихая вибрация
     * без рингтона"). When the ringer mode is NORMAL but the ring stream sits
     * below half its range, bump it to half so the ringtone is actually heard.
     *
     * Silent and vibrate ringer modes are respected (return `null`): forcing
     * audio there would override an explicit user choice. The vibration that
     * accompanies the ringer remains the fallback signal in those modes.
     *
     * @return the volume to apply via `setStreamVolume`, or `null` to leave
     *   the current volume untouched.
     */
    fun ringVolumeToForce(ringerMode: Int, currentVolume: Int, maxVolume: Int): Int? {
        if (ringerMode != RINGER_MODE_NORMAL) return null
        if (maxVolume <= 0) return null
        val target = maxVolume / 2
        if (currentVolume >= target) return null
        return target
    }

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
