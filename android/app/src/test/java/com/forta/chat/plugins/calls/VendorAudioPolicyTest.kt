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
    // requiresExplicitMicUnmuteOnStart() — broken-HW-AEC family (A1)
    // WEE-103: keyed off manufacturer/brand (the broken-AEC family), not the
    // coarse CallVendor enum, so OEMs detect() classifies as GENERIC are covered.
    // -------------------------------------------------------------------------

    @Test
    fun colorOsFamilyRequiresExplicitMicUnmuteOnStart() {
        // WEE-87 family: HONOR MagicOS, realme RealmeUI (#994/#995), OPPO ColorOS
        // and Xiaomi MIUI re-assert the global mic-mute flag mid-setup and must
        // force a start-time unmute.
        for (mfr in listOf("HONOR", "realme", "OPPO", "Xiaomi", "Redmi", "POCO")) {
            assertTrue(
                "$mfr (broken-HW-AEC ROM) must force a mic unmute mid-setup",
                VendorAudioPolicy.requiresExplicitMicUnmuteOnStart(mfr, ""),
            )
        }
    }

    @Test
    fun brokenAecOemsMissedByDetectStillRequireMicUnmute() {
        // WEE-103 regression: the previous gate keyed off detect()'s coarse
        // CallVendor enum, which returns GENERIC for Infinix/XOS (#1008) and
        // ZTE/nubia (#1009) — both ship broken HW AEC and strand the mic-mute
        // flag, but fell through to the generic path → both-ways silence on
        // 1.10.44 while video played. HUAWEI (#1009) was excluded by WEE-87 on a
        // "no mic-mute-flag report" assumption that #1009 falsifies. All three
        // are in the broken-HW-AEC family and must now force the unmute.
        assertTrue(
            "Infinix/XOS (#1008) must force a mic unmute mid-setup",
            VendorAudioPolicy.requiresExplicitMicUnmuteOnStart("Infinix Mobility Limited", "Infinix X665E"),
        )
        assertTrue(
            "ZTE/nubia (#1009) must force a mic unmute mid-setup",
            VendorAudioPolicy.requiresExplicitMicUnmuteOnStart("ZTE", "nubia NX733J"),
        )
        assertTrue(
            "HUAWEI (#1009) must force a mic unmute mid-setup",
            VendorAudioPolicy.requiresExplicitMicUnmuteOnStart("HUAWEI", "HUAWEI pure 70 ultra"),
        )
        assertTrue(
            "TECNO (broken-AEC family) must force a mic unmute mid-setup",
            VendorAudioPolicy.requiresExplicitMicUnmuteOnStart("TECNO MOBILE LIMITED", "TECNO KI5k"),
        )
    }

    @Test
    fun micUnmuteStaysInLockstepWithSoftwareAecFamily() {
        // The two HAL-driven remedies must key off ONE definition of the
        // broken-audio-HAL family so they can never drift apart again (the
        // WEE-76→WEE-87→WEE-103 too-narrow-gate cycle). For every (mfr, brand)
        // pair, needing software AEC ⇔ needing the start-time mic unmute.
        val samples = listOf(
            "HONOR" to "", "huawei" to "", "realme" to "", "Xiaomi" to "Redmi",
            "OPPO" to "", "Infinix Mobility Limited" to "Infinix X665E",
            "X665E" to "Infinix", // brand-only match (manufacturer carries no token)
            "ZTE" to "nubia NX733J", "TECNO MOBILE LIMITED" to "TECNO KI5k",
            "itel" to "Itel it2163",
            "samsung" to "samsung", "Google" to "Pixel", "OnePlus" to "",
            "" to "", null to null,
        )
        for ((mfr, brand) in samples) {
            assertEquals(
                "mic-unmute gate must match software-AEC gate for ($mfr, $brand)",
                VendorAudioPolicy.prefersSoftwareAudioProcessing(mfr, brand),
                VendorAudioPolicy.requiresExplicitMicUnmuteOnStart(mfr, brand),
            )
        }
    }

    @Test
    fun workingVendorsDoNotForceMicUnmuteOnStart() {
        // Samsung / Pixel / OnePlus / unknown-working OEMs ship working HW AEC and
        // must stay byte-for-byte on the proven generic WEE-54 start path (A5).
        assertFalse(VendorAudioPolicy.requiresExplicitMicUnmuteOnStart("samsung", "samsung"))
        assertFalse(VendorAudioPolicy.requiresExplicitMicUnmuteOnStart("Google", "Pixel"))
        assertFalse(VendorAudioPolicy.requiresExplicitMicUnmuteOnStart("OnePlus", ""))
        assertFalse(VendorAudioPolicy.requiresExplicitMicUnmuteOnStart(null, null))
        assertFalse(VendorAudioPolicy.requiresExplicitMicUnmuteOnStart("", ""))
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
    fun brokenHwAecVendors_matchMultiWordBuildStrings() {
        // WEE-60 regression: real OEM Build fields are rarely the bare token.
        // Infinix/Tecno/Itel ship multi-word MANUFACTURER/BRAND strings; the
        // old strict `==` predicate missed them and left the broken hardware
        // AEC active, producing one-way audio. Substring match fixes it.
        assertTrue(
            "multi-word Infinix manufacturer must still prefer software AEC",
            VendorAudioPolicy.prefersSoftwareAudioProcessing("Infinix Mobility Limited", "Infinix X6525"),
        )
        assertTrue(
            VendorAudioPolicy.prefersSoftwareAudioProcessing("TECNO MOBILE LIMITED", "TECNO KI5k"),
        )
        assertTrue(
            VendorAudioPolicy.prefersSoftwareAudioProcessing("itel", "Itel it2163"),
        )
        assertTrue(
            "Xiaomi marketing brand strings carry the token mid-word",
            VendorAudioPolicy.prefersSoftwareAudioProcessing("Xiaomi", "Redmi Note 12"),
        )
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
