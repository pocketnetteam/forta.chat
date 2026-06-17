package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Regression tests for WEE-76 (#944 / #960) — speaker toggle never engages the
 * loudspeaker on several OEMs.
 *
 * On API 31+ the in-call speaker button routes ONLY through
 * `setCommunicationDevice(TYPE_BUILTIN_SPEAKER)`, which is a silent no-op on a
 * number of devices: it returns `false` under audio-stack contention, or the
 * built-in speaker is momentarily absent from `availableCommunicationDevices`
 * (the WEE-54 guard then keeps the current earpiece route to avoid the Android
 * 15 silence bug). Multiple users reported the toggle doing nothing.
 *
 * [AudioRouter.legacySpeakerphoneTarget] drives the cross-OEM legacy
 * `isSpeakerphoneOn` reinforcement applied to the built-in earpiece/speaker pair
 * after the modern routing call. Bluetooth / wired headsets stay owned by
 * `setCommunicationDevice` (predicate returns null) so the proven removable-route
 * path is untouched (A5).
 *
 * Pure predicate so it is covered by a JVM-only JUnit test without an
 * AudioManager / Robolectric.
 */
class AudioRouterSpeakerphoneFallbackTest {

    @Test
    fun speakerRequest_engagesLegacyLoudspeaker() {
        assertEquals(
            "explicit SPEAKER request must engage the legacy loudspeaker flag — " +
                "setCommunicationDevice(SPEAKER) is an unreliable no-op on several OEMs (#944/#960)",
            true,
            AudioRouter.legacySpeakerphoneTarget(AudioRouter.Device.SPEAKER),
        )
    }

    @Test
    fun earpieceRequest_disengagesLegacyLoudspeaker() {
        assertEquals(
            "EARPIECE request must disengage the loudspeaker so toggling back off works",
            false,
            AudioRouter.legacySpeakerphoneTarget(AudioRouter.Device.EARPIECE),
        )
    }

    @Test
    fun bluetoothRequest_leavesLegacyFlagUntouched() {
        assertNull(
            "Bluetooth is owned by setCommunicationDevice — the legacy speakerphone " +
                "flag must not fight it (A5: zero change to the proven BT path)",
            AudioRouter.legacySpeakerphoneTarget(AudioRouter.Device.BLUETOOTH),
        )
    }

    @Test
    fun wiredHeadsetRequest_leavesLegacyFlagUntouched() {
        assertNull(
            "wired/USB headset is owned by setCommunicationDevice — legacy flag untouched",
            AudioRouter.legacySpeakerphoneTarget(AudioRouter.Device.WIRED_HEADSET),
        )
    }

    @Test
    fun builtInRoutesAreMutuallyExclusive() {
        // The two built-in routes must map to opposite loudspeaker states so a
        // speaker→earpiece→speaker sequence always lands on the right device.
        val speaker = AudioRouter.legacySpeakerphoneTarget(AudioRouter.Device.SPEAKER)
        val earpiece = AudioRouter.legacySpeakerphoneTarget(AudioRouter.Device.EARPIECE)
        assertEquals(
            "built-in routes must request opposite loudspeaker states",
            speaker,
            earpiece?.not(),
        )
    }
}
