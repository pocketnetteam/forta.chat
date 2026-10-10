package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The in-call route goes through the Telecom connection.
 *
 * Found on a Samsung SM-A528B with Android 14 (stage 3, 2026-09-13): Telecom owns
 * the audio mode of a self-managed call, so every `setCommunicationDevice` from
 * [AudioRouter] was recorded and ignored — 16 speaker picks, and the audio policy
 * never once selected the loudspeaker. The only route change anyone heard was
 * Telecom's own switch to AirPods. Telecom does report its route to the
 * connection (`onAvailableCallEndpointsChanged`, `onCallEndpointChanged`,
 * `onCallAudioStateChanged` all reach `CallConnectionService` in that log).
 *
 * Source-level, like [AudioRoutePinContractTest]: Telecom cannot run under JUnit.
 * The rules live in [AudioRoutePolicyTest] and [TelecomAudioRouteTest].
 */
class TelecomAudioRouteContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val router by lazy { source("com/forta/chat/plugins/calls/AudioRouter.kt") }
    private val service by lazy { (source("com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + source("com/forta/chat/plugins/calls/CallConnection.kt")) }

    @Test
    fun everyRouteChange_asksTelecomBeforeTheAudioManager() {
        // setDeviceInternal is the one path for a pick, a device change and the
        // route chosen at start, so the request covers all three.
        val body = withoutComments(functionBody(router, "private\\s+fun\\s+setDeviceInternal\\s*\\("))
        val ask = body.indexOf("CallConnectionService.currentConnection?.")
        val request = body.indexOf("requestAudioRoute(device)")
        val audioManager = body.indexOf("setDeviceModern(device)")
        assertTrue("setDeviceInternal must ask the live connection:\n$body", ask in 0 until request)
        assertTrue(
            "the Telecom request must come before the AudioManager path, which stays for calls without a connection:\n$body",
            request in 0 until audioManager,
        )
    }

    @Test
    fun theRequest_namesAnOfferedEndpointOnApi34_andFallsBackToTheRouteConstant() {
        val body = withoutComments(functionBody(service, "fun\\s+requestAudioRoute\\s*\\("))
        val released = body.indexOf("if (released.get()) return false")
        val gate = body.indexOf("Build.VERSION_CODES.UPSIDE_DOWN_CAKE")
        val endpoint = body.indexOf("requestCallEndpointChange(")
        assertTrue("a released connection must refuse the request first:\n$body", released in 0 until gate)
        assertTrue("API 34+ must request one of the endpoints Telecom offered:\n$body", gate in 0 until endpoint)
        assertTrue(body.contains("availableEndpoints.firstOrNull"))
        assertTrue(
            "the route constant must remain the fallback:\n$body",
            body.contains("setAudioRoute(TelecomAudioRoute.routeFor(device))"),
        )
    }

    @Test
    fun aHeadsetRequest_skipsTheEndpointPath_onApi34() {
        // After a pick took the audio off the AirPods, Samsung's Android 14 Telecom
        // acknowledged requestCallEndpointChange(BLUETOOTH) and never switched (airpods1,
        // airpods2, 2026-09-15); setAudioRoute(ROUTE_BLUETOOTH) switched 5 of 5 (airpods-exp1).
        val body = withoutComments(functionBody(service, "fun\\s+requestAudioRoute\\s*\\("))
        val gate = body.indexOf("Build.VERSION_CODES.UPSIDE_DOWN_CAKE && TelecomAudioRoute.viaCallEndpoint(device)")
        val endpoint = body.indexOf("requestCallEndpointChange(")
        assertTrue("the endpoint path must be gated on the device as well as the API level:\n$body", gate in 0 until endpoint)
    }

    @Test
    fun theConnection_keepsTheEndpointsTelecomOffers() {
        val body = functionBody(service, "override\\s+fun\\s+onAvailableCallEndpointsChanged\\s*\\(")
        assertTrue(body.contains("this.availableEndpoints = "))
    }

    @Test
    fun telecomRouteReports_reachTheRouter() {
        val endpoint = withoutComments(functionBody(service, "override\\s+fun\\s+onCallEndpointChanged\\s*\\("))
        assertTrue(endpoint.contains("TelecomAudioRoute.deviceForEndpointType("))
        assertTrue(endpoint.contains("AudioRouter.getSharedInstance(context).onTelecomRouteChanged("))

        val state = withoutComments(functionBody(service, "override\\s+fun\\s+onCallAudioStateChanged\\s*\\("))
        assertTrue(state.contains("TelecomAudioRoute.deviceForRoute(state.route)"))
        assertTrue(state.contains("AudioRouter.getSharedInstance(context).onTelecomRouteChanged("))
        // API 34 reports the same change through both callbacks; mirroring it
        // twice would ask a pinned loudspeaker back twice.
        val skip = state.indexOf("Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return")
        assertTrue(
            "onCallAudioStateChanged must leave API 34+ to onCallEndpointChanged:\n$state",
            skip in 0 until state.indexOf("onTelecomRouteChanged("),
        )
    }

    @Test
    fun theRouter_mirrorsTelecom_throughThePolicy_underTheRouteLock() {
        val body = withoutComments(functionBody(router, "fun\\s+onTelecomRouteChanged\\s*\\("))
        val inactive = body.indexOf("if (!isActive) return")
        val lock = body.indexOf("synchronized(routeLock)")
        val decide = body.indexOf("AudioRoutePolicy.onTelecomRouteChanged(")
        assertTrue("a report outside a call must be ignored first:\n$body", inactive in 0 until lock)
        assertTrue("read-decide-apply must sit under routeLock:\n$body", lock in 0 until decide)
        assertTrue("a dropped pin must be cleared:\n$body", body.contains("if (!decision.keepPin) pinnedDevice = null"))
        assertTrue("Telecom's route is what the UI shows:\n$body", body.contains("activeDevice = route"))
        assertTrue("a pinned loudspeaker is asked back through the normal path:\n$body", body.contains("setDeviceInternal(target)"))
        assertTrue("listeners must hear the change:\n$body", body.contains("notifyListener()"))
        assertFalse(
            "mirroring must not re-apply the AudioManager route itself:\n$body",
            body.contains("setCommunicationDevice") || body.contains("setDeviceModern"),
        )
    }

    @Test
    fun theRouter_tellsThePolicyTheCallType_soAVideoCallCanReturnToTheLoudspeaker() {
        val body = withoutComments(functionBody(router, "fun\\s+onTelecomRouteChanged\\s*\\("))
        assertTrue(
            "the policy must know a video call from a voice call:\n$body",
            body.contains("AudioRoutePolicy.onTelecomRouteChanged(route, pinnedDevice, callType)"),
        )
    }

    @Test
    fun aPick_asksTelecomForThePickedDevice() {
        // 07e20893 sent a headset pick from the loudspeaker through the earpiece first. On
        // the Samsung the hop's own switch came too soon before the headset request to get
        // Telecom past its drop (airpods2: 0 of 4); a request that skips the endpoint path
        // needs no first step.
        val body = withoutComments(functionBody(router, "fun\\s+setDevice\\s*\\("))
        val lock = body.indexOf("synchronized(routeLock)")
        val ask = body.indexOf("setDeviceInternal(device)")
        assertTrue("a pick must ask for the picked device under routeLock:\n$body", lock in 0 until ask)
        assertFalse("a pick must not route through another device first:\n$body", body.contains("firstStep"))
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
