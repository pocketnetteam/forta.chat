package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins how `onCreateIncomingConnection` treats a second Telecom registration of
 * the call that is already ringing. While the app is alive, one call push
 * reaches Telecom twice — FCM rings natively and the push forwarded to JS
 * reports the call again — and displacing the first connection fired
 * `callEnded` into JS for the very call that was still ringing. Source-level,
 * like [IncomingRingerContractTest]: Telecom cannot run under JUnit.
 */
class DuplicateIncomingRegistrationContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val body by lazy {
        functionBody(
            (source("com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + source("com/forta/chat/plugins/calls/CallConnection.kt")),
            "override\\s+fun\\s+onCreateIncomingConnection\\s*\\(",
        )
    }

    @Test
    fun theSameRingingCallIsRecognisedBeforeAnythingIsDisplaced() {
        val check = body.indexOf("DisplacedConnectionPolicy.isSameRingingCall(")
        val displace = body.indexOf("Displacing a stale connection")
        assertTrue("onCreateIncomingConnection must ask whether the slot already rings for this call:\n$body", check >= 0)
        assertTrue("that check must come before the displacement:\n$body", check < displace)
    }

    @Test
    fun aDuplicateRegistrationLeavesTheRingingConnectionAlone() {
        val branch = duplicateBranch()
        assertFalse("a duplicate must not disconnect the connection that rings:\n$branch", branch.contains("onDisconnect()"))
        assertFalse("a duplicate must not take the slot:\n$branch", branch.contains("currentConnection = "))
        assertTrue("a duplicate is refused with a failed connection:\n$branch", branch.contains("Connection.createFailedConnection("))
    }

    @Test
    fun aDuplicateRegistrationStillPresentsTheRinger() {
        // Refusing the second registration must not cost the call its screen: if
        // the ringer of the kept connection is gone, this is the moment to bring
        // it back, as the second connection used to.
        val branch = duplicateBranch()
        assertTrue("the kept call's ringer must be presented again:\n$branch", branch.contains("showIncomingCallUI("))
    }

    private fun duplicateBranch(): String {
        val start = body.indexOf("DisplacedConnectionPolicy.isSameRingingCall(")
        assertTrue("no duplicate check in onCreateIncomingConnection:\n$body", start >= 0)
        val ret = body.indexOf("return", start)
        assertTrue("the duplicate branch must return:\n$body", ret > start)
        return body.substring(start, body.indexOf('\n', ret))
    }

    private fun functionBody(src: String, signaturePattern: String): String {
        val match = Regex("$signaturePattern[^{]*\\{").find(src) ?: error("Could not find /$signaturePattern/ in source")
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
