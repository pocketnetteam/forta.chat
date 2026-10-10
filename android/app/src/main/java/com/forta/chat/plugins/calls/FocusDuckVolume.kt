package com.forta.chat.plugins.calls

/**
 * The voice-call volume change the call service's focus listener owns, so it
 * restores that change and nothing else.
 *
 * The service used to save the volume at the first focus request and write it
 * back on every AUDIOFOCUS_GAIN and at teardown. A user who turned the call up
 * or down with the rocker had that undone when the call ended, or the moment
 * focus came back from an unrelated transient loss. A duck also forced 30 % of
 * max even when the user's own level was lower, making a quiet call louder.
 *
 * Now only a duck is undone, and only when the volume still sits where the duck
 * put it: a rocker press during the duck is the user's choice and stays.
 * Main thread only.
 */
class FocusDuckVolume {

    private var restoreTo = -1
    private var duckedTo = -1

    /** A duck arrived. Returns the volume to set now, or -1 to leave it. */
    fun onDuck(current: Int, max: Int): Int {
        val target = minOf(current, (max * DUCK_FRACTION).toInt().coerceAtLeast(1))
        // A level the user set after the last duck is the one to restore now
        // (review 2026-10-08); a repeat duck on the ducked level keeps the
        // original.
        if (restoreTo < 0 || current != duckedTo) restoreTo = current
        duckedTo = target
        return if (target == current) -1 else target
    }

    /**
     * Focus came back or the call ended. Returns the volume to restore, or -1
     * when no duck is in force or the user changed the volume since.
     */
    fun release(current: Int): Int {
        val restore = restoreTo
        val ducked = duckedTo
        restoreTo = -1
        duckedTo = -1
        if (restore < 0 || current != ducked || current == restore) return -1
        return restore
    }

    private companion object {
        const val DUCK_FRACTION = 0.3
    }
}
