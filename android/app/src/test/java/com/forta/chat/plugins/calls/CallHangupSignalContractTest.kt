package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Where [CallHangupSignal] is captured, sent and dropped. Source-level, like
 * [IdleProcessExitContractTest]: the WebView, Telecom and a task swipe cannot
 * exist under JUnit. The target and the request are pinned in
 * [CallHangupSignalTest].
 */
class CallHangupSignalContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val connection by lazy { (source("com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + source("com/forta/chat/plugins/calls/CallConnection.kt")) }
    private val plugin by lazy { source("com/forta/chat/plugins/calls/CallPlugin.kt") }
    private val teardown by lazy { source("com/forta/chat/plugins/calls/CallTeardown.kt") }
    private val exit by lazy { source("com/forta/chat/plugins/calls/IdleProcessExit.kt") }

    @Test
    fun taskRemovedRelease_sendsTheHangupBeforeDisconnecting() {
        val body = withoutComments(functionBody(connection, "fun\\s+releaseOnTaskRemoved\\s*\\("))
        val ringing = body.indexOf("STATE_RINGING")
        val taken = body.indexOf("CallHangupSignal.take(connection.callId)")
        val sent = body.indexOf("CallHangupSignal.sendAsync(")
        val disconnected = body.indexOf("connection.onDisconnect()")
        assertTrue("a ringing call must return before the hangup is taken:\n$body", ringing in 0 until taken)
        assertTrue("the hangup must be sent before onDisconnect forgets the target:\n$body", taken in 0 until sent && sent < disconnected)
    }

    @Test
    fun plugin_capturesTheTargetWhenDiallingAndWhenConnected() {
        for (method in listOf("reportOutgoingCall", "reportCallConnected")) {
            val body = withoutComments(functionBody(plugin, "fun\\s+$method\\s*\\("))
            assertTrue("$method must capture the hangup target:\n$body", body.contains("captureHangupTarget("))
        }
        val capture = withoutComments(functionBody(plugin, "fun\\s+captureHangupTarget\\s*\\("))
        assertTrue("the target must be read with evaluateJavascript, not passed as plugin call data:\n$capture",
            capture.contains("evaluateJavascript(") && capture.contains("CallHangupSignal.captureScript("))
        assertTrue("a page that has not installed its provider yet must be asked again:\n$capture",
            capture.contains("retriesLeft > 0") && capture.contains("captureHangupTarget(callId, retriesLeft - 1)"))
    }

    @Test
    fun send_takesTheTorRouteFromTheAppsOwnRule() {
        val signal = source("com/forta/chat/plugins/calls/CallHangupSignal.kt")
        val route = withoutComments(functionBody(signal, "fun\\s+routeThroughTor\\s*\\("))
        assertTrue("the route must come from the persisted mode and the daemon state, not from JS:\n$route",
            route.contains("ConfigurationManager(context).loadSettings().mode") &&
                route.contains("TorManager.lastKnownState") &&
                route.contains("TorRouteDecider().isUseWithTor("))
        assertTrue("the JS context must not carry a Tor flag any more", !signal.contains("viaTorProxy=") )
        val send = withoutComments(functionBody(signal, "fun\\s+send\\s*\\("))
        assertTrue("a Tor send must go to the reverse proxy, not through Proxy.Type.HTTP:\n$send",
            send.contains("torUrl(request.url)") && !send.contains("Proxy("))
    }

    @Test
    fun teardown_forgetsTheEndedCall() {
        val body = withoutComments(functionBody(teardown, "fun\\s+endCall\\s*\\("))
        assertTrue("endCall must drop the hangup target of the call it ends:\n$body",
            body.contains("CallHangupSignal.forget(callId)"))
    }

    @Test
    fun idleExit_waitsForAHangupOnTheWire() {
        val body = withoutComments(functionBody(exit, "fun\\s+snapshot\\s*\\("))
        assertTrue("the idle check must see a hangup still being sent:\n$body",
            body.contains("hangupSending = CallHangupSignal.isSending"))
    }

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
