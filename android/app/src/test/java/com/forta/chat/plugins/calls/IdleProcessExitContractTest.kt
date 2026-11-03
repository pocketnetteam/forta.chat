package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A process whose call is over ends itself, so a kill the system deferred when
 * the user swiped a ringing call from Recents cannot fire into the next call
 * push.
 *
 * Found on the Samsung 2026-09-10 (`kill-repro1`): the leftover process died
 * with "remove task" in the same millisecond as the next push's
 * `startActivity`, before Telecom or the ringer were reached. Source-level,
 * like [AnswerAdoptionContractTest]: the task list, the running services and
 * the process itself cannot exist under JUnit. The decision is pinned in
 * [IdleProcessExitPolicyTest].
 */
class IdleProcessExitContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val connection by lazy { (source("com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + source("com/forta/chat/plugins/calls/CallConnection.kt")) }
    private val callService by lazy { source("com/forta/chat/plugins/calls/CallForegroundService.kt") }
    private val exit by lazy { source("com/forta/chat/plugins/calls/IdleProcessExit.kt") }
    private val push by lazy { source("com/forta/chat/FortaFirebaseMessagingService.kt") }

    @Test
    fun onDisconnect_schedulesTheCheck_afterVacatingTheSlot() {
        val body = withoutComments(functionBody(connection, "override\\s+fun\\s+onDisconnect\\s*\\("))
        val vacated = body.indexOf("CallConnectionService.currentConnection = null")
        val scheduled = body.indexOf("IdleProcessExit.schedule(")
        assertTrue("onDisconnect must schedule the idle check after vacating the slot:\n$body", vacated in 0 until scheduled)
    }

    @Test
    fun onReject_schedulesTheCheck_afterVacatingTheSlot() {
        // The ring timeout ends an unanswered swiped call through onReject.
        val body = withoutComments(functionBody(connection, "override\\s+fun\\s+onReject\\s*\\("))
        val vacated = body.indexOf("CallConnectionService.currentConnection = null")
        val scheduled = body.indexOf("IdleProcessExit.schedule(")
        assertTrue("onReject must schedule the idle check after vacating the slot:\n$body", vacated in 0 until scheduled)
    }

    @Test
    fun theCallServiceTeardown_schedulesTheCheck_afterClearingLiveness() {
        val body = withoutComments(functionBody(callService, "override\\s+fun\\s+onDestroy\\s*\\("))
        val cleared = body.lastIndexOf("instance = null")
        val scheduled = body.indexOf("IdleProcessExit.schedule(")
        assertTrue("onDestroy must schedule the idle check once the service is no longer running:\n$body", cleared in 0 until scheduled)
    }

    @Test
    fun theSnapshot_readsTasksConnectionRingerAndServices() {
        val body = withoutComments(functionBody(exit, "private\\s+fun\\s+snapshot\\s*\\("))
        listOf("hasRunningTask(", "CallConnectionService.currentConnection", "IncomingRinger.ringingCallId", "busyServices(", "isRecentCallPush(")
            .forEach { assertTrue("snapshot must read $it:\n$body", body.contains(it)) }
    }

    @Test
    fun aCallPush_holdsTheProcess_beforeItIsPresented() {
        // Telecom creates the connection only after the handler returns; a check
        // landing in between would end the process under the redial.
        val body = withoutComments(functionBody(push, "override\\s+fun\\s+onMessageReceived\\s*\\("))
        val branch = body.indexOf("if (msgType == \"m.call.invite\")")
        val noted = body.indexOf("IdleProcessExit.noteCallPush()")
        val presented = body.indexOf("showCallNotification(roomId")
        assertTrue("the invite branch must note the push first:\n$body", branch in 0 until noted)
        assertTrue("the push must be noted before the call is presented", noted in 0 until presented)
    }

    @Test
    fun aRetry_replacesAPendingCheck_ratherThanQueueingASecond() {
        val body = withoutComments(functionBody(exit, "private\\s+fun\\s+act\\s*\\("))
        val removed = body.indexOf("handler.removeCallbacks(check)")
        val posted = body.indexOf("handler.postDelayed(check, IdleProcessExitPolicy.RETRY_MS)")
        assertTrue("a retry must drop a pending check before posting:\n$body", removed in 0 until posted)
    }

    @Test
    fun onlyStartedOrForegroundServices_ofThisProcess_countAsBusy() {
        // Telecom keeps its binding to CallConnectionService for a moment after
        // the call; a bound-only service must not hold the exit back.
        val body = withoutComments(functionBody(exit, "private\\s+fun\\s+busyServices\\s*\\("))
        assertTrue("busy services must be this process's:\n$body", body.contains("it.pid == pid"))
        assertTrue("busy services must be started or foreground:\n$body", body.contains("it.started || it.foreground"))
    }

    @Test
    fun theExit_flushesPreferences_andChecksAgain_beforeKilling() {
        val flush = withoutComments(functionBody(exit, "private\\s+fun\\s+flushPreferences\\s*\\("))
        // commit() waits behind every apply() still queued for that file — the
        // pending answer/reject markers the teardown just wrote.
        assertTrue("the flush must commit:\n$flush", flush.contains(".edit().commit()"))

        val flushThenExit = withoutComments(functionBody(exit, "private\\s+fun\\s+flushThenExit\\s*\\("))
        assertTrue(
            "the kill must run only after the flush:\n$flushThenExit",
            flushThenExit.indexOf("flushPreferences(") in 0 until flushThenExit.indexOf("killIfStillIdle("),
        )

        val kill = withoutComments(functionBody(exit, "private\\s+fun\\s+killIfStillIdle\\s*\\("))
        val recheck = kill.indexOf("IdleProcessExitPolicy.decide(")
        val killed = kill.indexOf("Process.killProcess(")
        assertTrue("the process must be checked again right before the kill:\n$kill", recheck in 0 until killed)
    }

    @Test
    fun nothingOutsideTheExitPath_killsTheProcess() {
        val outside = withoutComments(exit).replace(
            withoutComments(functionBody(exit, "private\\s+fun\\s+killIfStillIdle\\s*\\(")),
            "",
        )
        assertFalse("only killIfStillIdle may kill the process", outside.contains("killProcess("))
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
