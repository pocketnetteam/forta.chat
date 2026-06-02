package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WEE-56 — regression tests for the centralised per-vendor audio policy.
 *
 * Pure JVM tests: [VendorAudioPolicy] has no Android framework dependencies so
 * the decision logic is covered without Robolectric / mockk. The imperative
 * `AudioManager` effects in [AudioRouter] are thin shells over these
 * predicates; the on-device routing behaviour itself still needs physical
 * Honor/Huawei QA before merge.
 */
class VendorAudioPolicyTest {

    // -------------------------------------------------------------------------
    // detect() — coarse vendor classification
    // -------------------------------------------------------------------------

    @Test
    fun detect_honor_fromManufacturer() {
        assertEquals(CallVendor.HONOR, VendorAudioPolicy.detect("HONOR", "HONOR"))
    }

    @Test
    fun detect_honor_isCaseInsensitive() {
        assertEquals(CallVendor.HONOR, VendorAudioPolicy.detect("honor", ""))
        assertEquals(CallVendor.HONOR, VendorAudioPolicy.detect("Honor", "Honor"))
    }

    @Test
    fun detect_honor_fromHihonorToken() {
        // Newer Honor firmware reports a "hihonor" manufacturer token; it must
        // still classify as HONOR, not fall through to GENERIC.
        assertEquals(CallVendor.HONOR, VendorAudioPolicy.detect("HIHONOR", ""))
    }

    @Test
    fun detect_honor_winsOverHuawei_whenBothTokensPresent() {
        // Post-2020 Honor is a separate company with its own MagicOS HAL — an
        // "honor" token must not be swallowed by a broad "huawei" match.
        // Some legacy firmware still tags brand=Honor while manufacturer=HUAWEI.
        assertEquals(CallVendor.HONOR, VendorAudioPolicy.detect("HUAWEI", "Honor"))
    }

    @Test
    fun detect_huawei() {
        assertEquals(CallVendor.HUAWEI, VendorAudioPolicy.detect("HUAWEI", "HUAWEI"))
    }

    @Test
    fun detect_realme() {
        assertEquals(CallVendor.REALME, VendorAudioPolicy.detect("realme", "realme"))
    }

    @Test
    fun detect_xiaomi_familyTokens() {
        assertEquals(CallVendor.XIAOMI, VendorAudioPolicy.detect("Xiaomi", "Redmi"))
        assertEquals(CallVendor.XIAOMI, VendorAudioPolicy.detect("Xiaomi", "POCO"))
        assertEquals(CallVendor.XIAOMI, VendorAudioPolicy.detect("Redmi", ""))
    }

    @Test
    fun detect_oppo() {
        assertEquals(CallVendor.OPPO, VendorAudioPolicy.detect("OPPO", ""))
    }

    @Test
    fun detect_samsung() {
        assertEquals(CallVendor.SAMSUNG, VendorAudioPolicy.detect("samsung", "samsung"))
    }

    @Test
    fun detect_unknownVendor_isGeneric() {
        assertEquals(CallVendor.GENERIC, VendorAudioPolicy.detect("Google", "google"))
        assertEquals(CallVendor.GENERIC, VendorAudioPolicy.detect("OnePlus", "OnePlus"))
    }

    @Test
    fun detect_nullOrBlank_isGeneric() {
        assertEquals(CallVendor.GENERIC, VendorAudioPolicy.detect(null, null))
        assertEquals(CallVendor.GENERIC, VendorAudioPolicy.detect("", ""))
        assertEquals(CallVendor.GENERIC, VendorAudioPolicy.detect("  ", null))
    }

    // -------------------------------------------------------------------------
    // requiresExplicitMicUnmuteOnStart() — HONOR-only (A1)
    // -------------------------------------------------------------------------

    @Test
    fun honorRequiresExplicitMicUnmuteOnStart() {
        assertTrue(VendorAudioPolicy.requiresExplicitMicUnmuteOnStart(CallVendor.HONOR))
    }

    @Test
    fun nonHonorVendorsDoNotForceMicUnmuteOnStart() {
        // Gated to HONOR so the proven generic start path is untouched on every
        // other device (A5). Post-call reset covers the rest.
        for (v in CallVendor.entries) {
            if (v == CallVendor.HONOR) continue
            assertFalse(
                "$v must not force a mic unmute mid-setup",
                VendorAudioPolicy.requiresExplicitMicUnmuteOnStart(v),
            )
        }
    }

    // -------------------------------------------------------------------------
    // shouldUnmuteMicOnStop() — every vendor (A3, Telegram-empty-voice)
    // -------------------------------------------------------------------------

    @Test
    fun everyVendorUnmutesMicOnStop() {
        // setMicrophoneMute is process-global; clearing it on teardown can only
        // release a stuck capture path, so the policy is vendor-independent.
        for (v in CallVendor.entries) {
            assertTrue(
                "$v must release the global mic-mute flag on call teardown",
                VendorAudioPolicy.shouldUnmuteMicOnStop(v),
            )
        }
    }

    // -------------------------------------------------------------------------
    // prefersSoftwareAudioProcessing() — parity with the prior
    // NativeWebRTCManager.BROKEN_HW_AEC_VENDORS behaviour (A2)
    // -------------------------------------------------------------------------

    @Test
    fun brokenHwAecVendors_preferSoftwareProcessing() {
        val brokenVendors = listOf(
            "xiaomi", "redmi", "poco",
            "realme", "oppo",
            "infinix", "itel", "tecno",
            "huawei", "honor", "zte",
        )
        for (v in brokenVendors) {
            assertTrue(
                "$v ships broken HW AEC — must fall back to software processing",
                VendorAudioPolicy.prefersSoftwareAudioProcessing(v, ""),
            )
        }
    }

    @Test
    fun brokenHwAecVendors_matchViaBrandToo() {
        // The prior implementation matched manufacturer OR brand — preserve it.
        assertTrue(VendorAudioPolicy.prefersSoftwareAudioProcessing("UnknownOem", "Huawei"))
    }

    @Test
    fun brokenHwAecVendors_areCaseInsensitive() {
        assertTrue(VendorAudioPolicy.prefersSoftwareAudioProcessing("HUAWEI", ""))
        assertTrue(VendorAudioPolicy.prefersSoftwareAudioProcessing("Realme", ""))
    }

    @Test
    fun hihonorToken_prefersSoftwareProcessing() {
        // detect() maps "hihonor" → HONOR via substring; keep the HW-AEC set in
        // step so a hihonor-only Build also gets the software fallback.
        assertTrue(VendorAudioPolicy.prefersSoftwareAudioProcessing("hihonor", ""))
    }

    @Test
    fun nullManufacturerWithVendorBrand_prefersSoftwareProcessing() {
        // Intentional, safer divergence from the prior predicate (which ignored
        // brand when manufacturer was null): a vendor exposed only via
        // Build.BRAND still falls back to software audio processing.
        assertTrue(VendorAudioPolicy.prefersSoftwareAudioProcessing(null, "huawei"))
    }

    @Test
    fun workingHwAecVendors_keepHardwareProcessing() {
        // Samsung / Pixel / OnePlus ship working HW AEC and must stay on it.
        assertFalse(VendorAudioPolicy.prefersSoftwareAudioProcessing("samsung", "samsung"))
        assertFalse(VendorAudioPolicy.prefersSoftwareAudioProcessing("Google", "Pixel"))
        assertFalse(VendorAudioPolicy.prefersSoftwareAudioProcessing("OnePlus", ""))
    }

    @Test
    fun nullOrBlankBuild_keepsHardwareProcessing() {
        assertFalse(VendorAudioPolicy.prefersSoftwareAudioProcessing(null, null))
        assertFalse(VendorAudioPolicy.prefersSoftwareAudioProcessing("", ""))
    }
}
