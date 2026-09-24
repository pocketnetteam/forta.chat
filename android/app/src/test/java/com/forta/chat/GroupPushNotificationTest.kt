package com.forta.chat

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Regression tests for [FortaFirebaseMessagingService.buildMessageNotification].
 *
 * User reports: a push from a group chat looked exactly like a push from a
 * direct chat — the title was always the sender's display name, so nothing on
 * screen said which group the message belonged to. Group pushes now render as
 * `title = room name` / `body = "Sender: preview"`, while direct chats keep
 * the previous sender-titled layout.
 *
 * Group-ness is not in the FCM payload; it is mirrored from Dexie into
 * SharedPreferences by JS (`PushData.cacheGroupRooms`) and read back by
 * `isGroupRoom`.
 */
class GroupPushNotificationTest {

    private val fallback = "New message"

    @Test
    fun `group push shows the room name as title and folds the sender into the body`() {
        val content = FortaFirebaseMessagingService.buildMessageNotification(
            senderDisplayName = "Alice",
            cachedSenderName = null,
            roomName = "Forta Team",
            cachedRoomName = null,
            isGroup = true,
            body = "see you at 10",
            fallback = fallback,
        )
        assertEquals("Forta Team", content.title)
        assertEquals("Alice: see you at 10", content.body)
    }

    @Test
    fun `direct push keeps the sender-titled layout`() {
        val content = FortaFirebaseMessagingService.buildMessageNotification(
            senderDisplayName = "Alice",
            cachedSenderName = null,
            roomName = "Alice",
            cachedRoomName = null,
            isGroup = false,
            body = "see you at 10",
            fallback = fallback,
        )
        assertEquals("Alice", content.title)
        assertEquals("see you at 10", content.body)
    }

    @Test
    fun `group push falls back to the cached room name`() {
        val content = FortaFirebaseMessagingService.buildMessageNotification(
            senderDisplayName = "Alice",
            cachedSenderName = null,
            roomName = null,
            cachedRoomName = "Forta Team",
            isGroup = true,
            body = "see you at 10",
            fallback = fallback,
        )
        assertEquals("Forta Team", content.title)
        assertEquals("Alice: see you at 10", content.body)
    }

    @Test
    fun `group push with an unknown room name degrades to the direct layout`() {
        val content = FortaFirebaseMessagingService.buildMessageNotification(
            senderDisplayName = "Alice",
            cachedSenderName = null,
            roomName = "  ",
            cachedRoomName = null,
            isGroup = true,
            body = "see you at 10",
            fallback = fallback,
        )
        assertEquals("Alice", content.title)
        assertEquals("see you at 10", content.body)
    }

    @Test
    fun `group push with an unknown sender does not prefix the body`() {
        val content = FortaFirebaseMessagingService.buildMessageNotification(
            senderDisplayName = null,
            cachedSenderName = null,
            roomName = "Forta Team",
            cachedRoomName = null,
            isGroup = true,
            body = "Photo",
            fallback = fallback,
        )
        assertEquals("Forta Team", content.title)
        assertEquals("Photo", content.body)
    }

    @Test
    fun `a Matrix ID sender is still rejected in the group layout`() {
        val content = FortaFirebaseMessagingService.buildMessageNotification(
            senderDisplayName = "@PXXX123:matrix.bastyon.com",
            cachedSenderName = "Bob",
            roomName = "Forta Team",
            cachedRoomName = null,
            isGroup = true,
            body = "see you at 10",
            fallback = fallback,
        )
        assertEquals("Forta Team", content.title)
        assertEquals("Bob: see you at 10", content.body)
    }

    @Test
    fun `group room key is namespaced per room`() {
        assertEquals("room_is_group_!abc:server", FortaFirebaseMessagingService.groupRoomKey("!abc:server"))
    }
}
