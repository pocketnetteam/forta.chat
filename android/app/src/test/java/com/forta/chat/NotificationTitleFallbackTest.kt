package com.forta.chat

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Regression tests for [FortaFirebaseMessagingService.chooseNotificationTitle].
 *
 * Anchors the WEE-11 contract:
 *   * forta-bugs#660 — push notification title shows raw Matrix ID
 *     ("@PXXX...:matrix.bastyon.com") instead of a human-readable name.
 *   * forta-bugs#686 — push title/message desync.
 *
 * Push gateway sometimes emits `sender_display_name` equal to the raw
 * Matrix ID (when the sender has no homeserver-side displayname). Without
 * an `isMatrixId` guard in the fallback chain, that opaque ID becomes the
 * notification title — visible to every cold-start user before JS-side
 * replacement can run.
 */
class NotificationTitleFallbackTest {

    @Test
    fun `Matrix ID in sender_display_name is rejected, falls through to room name`() {
        val title = FortaFirebaseMessagingService.chooseNotificationTitle(
            senderDisplayName = "@PXXX123:matrix.bastyon.com",
            cachedSenderName = null,
            roomName = "Group A",
            cachedRoomName = null,
            fallback = "New message",
        )
        assertEquals("Group A", title)
    }

    @Test
    fun `real display name is preferred over room name`() {
        val title = FortaFirebaseMessagingService.chooseNotificationTitle(
            senderDisplayName = "Alice",
            cachedSenderName = null,
            roomName = "Group A",
            cachedRoomName = null,
            fallback = "New message",
        )
        assertEquals("Alice", title)
    }

    @Test
    fun `Matrix ID in cached sender name is also rejected`() {
        val title = FortaFirebaseMessagingService.chooseNotificationTitle(
            senderDisplayName = null,
            cachedSenderName = "@PYYY456:matrix.example.org",
            roomName = "Group B",
            cachedRoomName = null,
            fallback = "New message",
        )
        assertEquals("Group B", title)
    }

    @Test
    fun `cached sender name used when fresh sender_display_name is missing`() {
        val title = FortaFirebaseMessagingService.chooseNotificationTitle(
            senderDisplayName = null,
            cachedSenderName = "Bob",
            roomName = "Group C",
            cachedRoomName = null,
            fallback = "New message",
        )
        assertEquals("Bob", title)
    }

    @Test
    fun `cached room name used when fresh room name is missing`() {
        val title = FortaFirebaseMessagingService.chooseNotificationTitle(
            senderDisplayName = "@PZZZ:server",
            cachedSenderName = null,
            roomName = null,
            cachedRoomName = "Cached Group",
            fallback = "New message",
        )
        assertEquals("Cached Group", title)
    }

    @Test
    fun `final fallback when everything is null or matrix-id`() {
        val title = FortaFirebaseMessagingService.chooseNotificationTitle(
            senderDisplayName = "@PXXX:matrix.bastyon.com",
            cachedSenderName = "@PYYY:matrix.bastyon.com",
            roomName = null,
            cachedRoomName = null,
            fallback = "New message",
        )
        assertEquals("New message", title)
    }

    @Test
    fun `display name with at sign but no colon is not a Matrix ID`() {
        // E.g. someone literally named "@bob" — must NOT be filtered out.
        val title = FortaFirebaseMessagingService.chooseNotificationTitle(
            senderDisplayName = "@bob",
            cachedSenderName = null,
            roomName = "Group D",
            cachedRoomName = null,
            fallback = "New message",
        )
        assertEquals("@bob", title)
    }

    @Test
    fun `degenerate matrix-id-shaped strings are rejected`() {
        // Defensive: "@:", "@a:", "@:server" are neither legitimate display
        // names nor valid Matrix IDs. Treat them like raw IDs and fall
        // through to room name.
        for (degenerate in listOf("@:", "@:server", "@a:", "@ user:srv", "@a: ")) {
            val title = FortaFirebaseMessagingService.chooseNotificationTitle(
                senderDisplayName = degenerate,
                cachedSenderName = null,
                roomName = "Group X",
                cachedRoomName = null,
                fallback = "New message",
            )
            assertEquals("rejecting <$degenerate>", "Group X", title)
        }
    }

    @Test
    fun `blank sender_display_name falls through to next entry`() {
        val title = FortaFirebaseMessagingService.chooseNotificationTitle(
            senderDisplayName = "   ",
            cachedSenderName = "Carol",
            roomName = "Group E",
            cachedRoomName = null,
            fallback = "New message",
        )
        assertEquals("Carol", title)
    }
}
