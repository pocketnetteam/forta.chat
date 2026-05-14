package com.forta.chat.plugins.savemedia

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Regression tests for Session 58 — Save → Share regression fix.
 *
 * Verifies MediaStore RELATIVE_PATH resolution for each MIME family.
 * Pure-function tests cover the routing logic without Robolectric /
 * Android framework dependency, so they run on the JVM via `./gradlew
 * testDebugUnitTest`.
 *
 * Background: prior to Session 58, `saveFileNative` wrote to
 * `Directory.Cache` and tried `FileOpener.open()`. On Android 14+ scoped
 * storage blocks cache file:// URI exposure — FileOpener throws and a
 * silent catch fell back to Share.share(), so users saw a Share dialog
 * instead of a saved file. SaveMediaPlugin replaces that pipeline with
 * an explicit MediaStore.insert() call.
 */
class SaveMediaPluginTest {

    @Test
    fun `image MIME routes to Pictures Forta Chat`() {
        assertEquals(
            "Pictures/Forta Chat",
            SaveMediaPlugin.relativePathForMime("image/jpeg"),
        )
    }

    @Test
    fun `image png routes to Pictures Forta Chat`() {
        assertEquals(
            "Pictures/Forta Chat",
            SaveMediaPlugin.relativePathForMime("image/png"),
        )
    }

    @Test
    fun `video MIME routes to Movies Forta Chat`() {
        assertEquals(
            "Movies/Forta Chat",
            SaveMediaPlugin.relativePathForMime("video/mp4"),
        )
    }

    @Test
    fun `audio MIME routes to Music Forta Chat`() {
        assertEquals(
            "Music/Forta Chat",
            SaveMediaPlugin.relativePathForMime("audio/ogg"),
        )
    }

    @Test
    fun `document MIME routes to Download Forta Chat`() {
        assertEquals(
            "Download/Forta Chat",
            SaveMediaPlugin.relativePathForMime("application/pdf"),
        )
    }

    @Test
    fun `unknown MIME falls back to Download Forta Chat`() {
        assertEquals(
            "Download/Forta Chat",
            SaveMediaPlugin.relativePathForMime("application/x-binary"),
        )
    }
}
