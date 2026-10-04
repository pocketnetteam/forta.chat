package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
import org.junit.Test

class FocusDuckVolumeTest {

    @Test
    fun `restores the level a duck lowered`() {
        val duck = FocusDuckVolume()
        assertEquals(3, duck.onDuck(current = 8, max = 10))
        assertEquals(8, duck.release(current = 3))
    }

    // Regression: the level saved at the first focus request was written back
    // at hangup and on every focus gain, undoing the user's rocker presses.
    @Test
    fun `leaves the volume alone when no duck happened`() {
        val duck = FocusDuckVolume()
        assertEquals(-1, duck.release(current = 9))
    }

    @Test
    fun `keeps a level the user set during the duck`() {
        val duck = FocusDuckVolume()
        duck.onDuck(current = 8, max = 10)
        assertEquals(-1, duck.release(current = 5))
    }

    // Regression: a duck forced 30 % of max even above the user's own level.
    @Test
    fun `never raises a quiet call`() {
        val duck = FocusDuckVolume()
        assertEquals(-1, duck.onDuck(current = 2, max = 10))
        assertEquals(-1, duck.release(current = 2))
    }

    @Test
    fun `a second duck keeps the original level to restore`() {
        val duck = FocusDuckVolume()
        duck.onDuck(current = 8, max = 10)
        assertEquals(-1, duck.onDuck(current = 3, max = 10))
        assertEquals(8, duck.release(current = 3))
    }

    @Test
    fun `restores once`() {
        val duck = FocusDuckVolume()
        duck.onDuck(current = 8, max = 10)
        duck.release(current = 3)
        assertEquals(-1, duck.release(current = 3))
    }
}
