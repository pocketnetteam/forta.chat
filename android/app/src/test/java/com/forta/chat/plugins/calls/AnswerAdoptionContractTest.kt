package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * An answer Telecom delivered while JS was not there to pick it up must not
 * leave the connection ACTIVE for ever.
 *
 * Found on the Samsung 2026-09-13: a call swiped away while ringing kept
 * ringing in AirPods, a stem press answered it with JS dead, and `onAnswer`
 * cancelled the only timer the connection had. No hangup push reaches this
 * app and the cold-start sweep leaves a live slot alone, so the call stayed
 * ACTIVE until a force-stop — the device held in call audio mode, the next
 * call answered busy.
 *
 * Source-level, like [IncomingCallAcceptGuardTest]: Telecom and the main looper
 * cannot run under JUnit. The rule itself is pinned in [StaleCallPolicyTest].
 */
class AnswerAdoptionContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val service by lazy { (source("com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + source("com/forta/chat/plugins/calls/CallConnection.kt")) }
    private val plugin by lazy { source("com/forta/chat/plugins/calls/CallPlugin.kt") }

    @Test
    fun onAnswer_armsTheAdoptionBackstop_onceTheCallIsActive() {
        val body = withoutComments(functionBody(service, "override\\s+fun\\s+onAnswer\\s*\\("))
        val active = body.indexOf("setActive()")
        val arm = body.indexOf("armAdoptionTimeout()")
        assertTrue("onAnswer must arm the adoption backstop after setActive():\n$body", active in 0 until arm)
    }

    @Test
    fun theBackstop_releasesWithOnDisconnect_unlessJsAdoptedTheCall() {
        val runnable = withoutComments(
            functionBody(service, "private\\s+val\\s+adoptionTimeoutRunnable\\s*=\\s*Runnable\\s*"),
        )
        assertTrue(
            "the backstop must leave a call JS reported connected alone:\n$runnable",
            runnable.contains("if (adoptedByJs) return@Runnable"),
        )
        // Nothing catches a throw out of a main-looper Runnable, and this one
        // fires with nobody holding the phone.
        assertTrue(
            "the backstop must release through onDisconnect inside a catch:\n$runnable",
            runnable.contains("runCatching { onDisconnect() }"),
        )
        // onReject would record a decline for a call the caller gave up on long
        // ago; a reject marker can only ever decline something later.
        assertFalse("the backstop must not reject:\n$runnable", runnable.contains("onReject"))
    }

    @Test
    fun jsReportingTheCallConnected_adoptsTheConnectionItOwns() {
        val body = functionBody(plugin, "fun\\s+reportCallConnected\\s*\\(")
        val owns = body.indexOf("CallSlotPolicy.owns(")
        val adopt = body.indexOf("connection?.markAdoptedByJs()")
        assertTrue(
            "reportCallConnected must adopt the connection after the slot check:\n$body",
            owns in 0 until adopt,
        )
    }

    @Test
    fun adopting_setsTheFlagBeforeDisarmingTheBackstop() {
        val body = withoutComments(functionBody(service, "fun\\s+markAdoptedByJs\\s*\\("))
        val flag = body.indexOf("adoptedByJs = true")
        val cancel = body.indexOf("cancelAdoptionTimeout()")
        // Flag first: the runnable reads it, so a deadline already dequeued on
        // the main looper still sees the adoption.
        assertTrue("markAdoptedByJs must set the flag, then cancel the backstop:\n$body", flag in 0 until cancel)
    }

    @Test
    fun rejectAndDisconnect_disarmTheBackstop() {
        for (name in listOf("onReject", "onDisconnect")) {
            val body = functionBody(service, "override\\s+fun\\s+$name\\s*\\(")
            assertTrue("$name must cancel the adoption backstop:\n$body", body.contains("cancelAdoptionTimeout()"))
        }
    }

    @Test
    fun theResumeSweep_alsoReleasesAnAnswerJsNeverPickedUp() {
        // The backstop is a main-looper Handler, so Doze can hold it past its
        // deadline exactly like the ring timeout; the resume sweep is the
        // second net for both.
        val sweep = withoutComments(functionBody(plugin, "fun\\s+releaseStaleRingingCall\\s*\\("))
        assertTrue(
            "the resume sweep must also release an unadopted answer:\n$sweep",
            sweep.contains("CallConnectionService.releaseUnadoptedAnswer()"),
        )
        val release = withoutComments(functionBody(service, "fun\\s+releaseUnadoptedAnswer\\s*\\("))
        assertTrue("the release must go through StaleCallPolicy:\n$release", release.contains("StaleCallPolicy.isUnadoptedAnswer("))
        assertTrue(
            "the release must use the adoption deadline:\n$release",
            release.contains("CallConnection.ANSWER_ADOPTION_TIMEOUT_MS"),
        )
        assertTrue("the release must disconnect:\n$release", release.contains(".onDisconnect()"))
        assertFalse("the release must not reject:\n$release", release.contains("onReject"))
    }

    /** Drops `//` comment tails so an assertion measures code, not prose. */
    private fun withoutComments(body: String): String =
        body.lines().joinToString("\n") { line ->
            val at = line.indexOf("//")
            if (at >= 0) line.substring(0, at) else line
        }

    private fun functionBody(src: String, signaturePattern: String): String {
        val match = Regex("$signaturePattern[^{]*\\{").find(src)
            ?: error("Could not find /$signaturePattern/ in source")
        var depth = 1
        var i = match.range.last + 1
        val start = i
        while (i < src.length && depth > 0) {
            when (src[i]) {
                '{' -> depth++
                '}' -> depth--
            }
            i++
        }
        return src.substring(start, i - 1)
    }
}
