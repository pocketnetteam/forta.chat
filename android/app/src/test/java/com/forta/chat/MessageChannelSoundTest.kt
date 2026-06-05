package com.forta.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageChannelSoundTest {

    @Test
    fun `messages channel requests an explicit notification sound (regression for #942)`() {
        val spec = MessageNotificationConfig.messageChannelSpec("Messages", "desc")
        assertTrue(
            "Channel must request a sound — the silent channel was the #942 root cause on Xiaomi MIUI",
            spec.withSound,
        )
    }

    @Test
    fun `messages channel enables vibration`() {
        val spec = MessageNotificationConfig.messageChannelSpec("Messages", "desc")
        assertTrue(spec.withVibration)
    }

    @Test
    fun `messages channel uses IMPORTANCE_HIGH so it can play sound and pop a heads-up`() {
        val spec = MessageNotificationConfig.messageChannelSpec("Messages", "desc")
        assertEquals(MessageNotificationConfig.IMPORTANCE_HIGH, spec.importance)
    }

    @Test
    fun `IMPORTANCE_HIGH mirrors the NotificationManager constant value`() {
        // android.app.NotificationManager.IMPORTANCE_HIGH == 4
        assertEquals(4, MessageNotificationConfig.IMPORTANCE_HIGH)
    }

    @Test
    fun `migration channel id differs from every legacy id`() {
        for (legacyId in MessageNotificationConfig.LEGACY_MESSAGE_CHANNEL_IDS) {
            assertNotEquals(
                "Migration target must use a new id so Android recreates the channel with the sound fix",
                legacyId,
                MessageNotificationConfig.MESSAGES_CHANNEL_ID,
            )
        }
    }

    @Test
    fun `legacy ids include the original v1 messages channel`() {
        assertTrue(
            "Must delete the original 'messages' channel so its silent-from-old-install state cannot persist",
            MessageNotificationConfig.LEGACY_MESSAGE_CHANNEL_IDS.contains("messages"),
        )
    }

    @Test
    fun `spec id matches the active channel id constant`() {
        val spec = MessageNotificationConfig.messageChannelSpec("Messages", "desc")
        assertEquals(MessageNotificationConfig.MESSAGES_CHANNEL_ID, spec.id)
    }
}
