package com.forta.chat

/**
 * Pure, testable spec for the message NotificationChannel (WEE-75).
 *
 * Mirrors [com.forta.chat.plugins.calls.CallNotificationConfig]. The
 * original `messages` channel was created with vibration only and **no**
 * explicit `setSound(...)` — on a number of OEMs (notably Xiaomi/MIUI)
 * that yields silent message notifications (forta-bugs#942).
 *
 * A NotificationChannel is immutable once created, so we cannot simply add
 * a sound to the existing channel — Android ignores the change. The fix
 * mirrors the incoming-call migration (WEE-18): ship a new channel id and
 * delete the legacy one so Android recreates it with the corrected
 * settings.
 */
data class MessageChannelSpec(
    val id: String,
    val name: String,
    val description: String,
    val importance: Int,
    val withSound: Boolean,
    val withVibration: Boolean,
)

object MessageNotificationConfig {

    /** Active channel id. `_v2` because the legacy `messages` channel is
     *  immutable and stuck without a sound on existing installs. */
    const val MESSAGES_CHANNEL_ID = "messages_v2"

    /** Channels to delete so their silent-from-old-install state cannot
     *  persist. The original v1 channel was simply `messages`. */
    val LEGACY_MESSAGE_CHANNEL_IDS: List<String> = listOf("messages")

    /** NotificationManager.IMPORTANCE_HIGH — heads-up + sound. */
    const val IMPORTANCE_HIGH = 4

    fun messageChannelSpec(name: String, description: String): MessageChannelSpec =
        MessageChannelSpec(
            id = MESSAGES_CHANNEL_ID,
            name = name,
            description = description,
            importance = IMPORTANCE_HIGH,
            withSound = true,
            withVibration = true,
        )
}
