package com.forta.chat.plugins.calls

/**
 * WEE-56 — centralised per-vendor audio policy for the calls subsystem.
 *
 * Forta runs on a long tail of OEM ROMs whose audio HAL deviates from the
 * stock-Android contract the generic [AudioRouter] / [com.forta.chat.plugins.webrtc.NativeWebRTCManager]
 * paths assume. Before this class the vendor handling was scattered across two
 * ad-hoc checks that drifted independently:
 *
 *   - `NativeWebRTCManager.BROKEN_HW_AEC_VENDORS` (disable HW AEC/NS that mutes
 *     the mic on MIUI / EMUI / ColorOS / RealmeUI / XOS …)
 *   - `AudioRouter.modeReapplyScheduleMs()` (re-apply MODE_IN_COMMUNICATION after
 *     aggressive OEM resets)
 *
 * This object is the single source of truth the calls code consults for
 * vendor-conditional behaviour. It is intentionally **pure** (no Android
 * framework dependencies) so the decision logic is covered by plain JVM unit
 * tests without Robolectric / mockk, and so the imperative `AudioManager`
 * mutations in [AudioRouter] stay a thin shell over testable predicates.
 *
 * ## Design invariant (acceptance criterion A5)
 *
 * [CallVendor.GENERIC] is the default for any unmatched device, and every
 * vendor-specific tweak is **additive** to the proven WEE-54 generic path —
 * never a replacement. A device we do not recognise, or one whose vendor we
 * recognise but for which a given predicate returns the generic answer, runs
 * exactly the code it ran before WEE-56. This keeps the vast majority of
 * working devices untouched by construction.
 *
 * NOTE: the device-specific *routing* effects (HONOR one-way audio, HUAWEI
 * video-call silence) can only be validated on the physical Honor/Huawei
 * handsets from the bug cluster. The predicates here encode the policy and are
 * unit-tested; on-device QA is still required before merge.
 */
enum class CallVendor {
    HONOR,
    HUAWEI,
    REALME,
    XIAOMI,
    OPPO,
    SAMSUNG,
    GENERIC,
}

object VendorAudioPolicy {

    /**
     * Vendors whose **hardware** AEC/NS is known to mute the capture path or
     * lock the audio session, requiring the libwebrtc software AEC/NS instead.
     *
     * This is the authoritative list that
     * [com.forta.chat.plugins.webrtc.NativeWebRTCManager.hasBrokenHardwareAudioProcessing]
     * delegates to — kept here (not in the WebRTC manager) so the calls and
     * webrtc packages share one definition and a single JVM test locks it.
     *
     * Evidence from user reports: Xiaomi/MIUI, Realme/RealmeUI, Oppo/ColorOS,
     * Infinix/XOS, Tecno/HiOS, Huawei/EMUI, Honor/MagicOS, ZTE. Samsung / Pixel
     * / OnePlus ship working HW AEC and deliberately stay off this list (lower
     * CPU, better quality).
     */
    private val BROKEN_HW_AEC_VENDORS = setOf(
        "xiaomi", "redmi", "poco",
        "realme",
        "oppo",
        "infinix", "itel",
        "tecno",
        "huawei", "honor", "hihonor",
        "zte",
    )

    /**
     * Coarse vendor classification used to pick an audio-routing strategy.
     *
     * Matching is case-insensitive against both `Build.MANUFACTURER` and
     * `Build.BRAND` because OEMs are inconsistent about which field carries the
     * recognisable name (e.g. Honor reports MANUFACTURER=HONOR but some Huawei-
     * era firmware still tags BRAND=Honor). HONOR is checked before HUAWEI on
     * purpose: post-2020 Honor is a separate company with its own MagicOS HAL,
     * so an "honor" / "hihonor" token must classify as [CallVendor.HONOR] and
     * not be swallowed by a broad "huawei" match.
     */
    fun detect(manufacturer: String?, brand: String?): CallVendor {
        val m = manufacturer?.trim()?.lowercase().orEmpty()
        val b = brand?.trim()?.lowercase().orEmpty()
        fun matches(token: String) = m.contains(token) || b.contains(token)

        return when {
            matches("honor") || matches("hihonor") -> CallVendor.HONOR
            matches("huawei") -> CallVendor.HUAWEI
            matches("realme") -> CallVendor.REALME
            matches("xiaomi") || matches("redmi") || matches("poco") -> CallVendor.XIAOMI
            matches("oppo") -> CallVendor.OPPO
            matches("samsung") -> CallVendor.SAMSUNG
            else -> CallVendor.GENERIC
        }
    }

    /**
     * Aggressive Chinese ROMs (MagicOS / RealmeUI / ColorOS / MIUI) that are
     * known to re-assert the process-global microphone-mute flag during call
     * setup, stranding the local capture path in silence so the peer hears
     * nothing. These all already ship broken HW AEC (see
     * [BROKEN_HW_AEC_VENDORS]) — the same audio HAL that mutes capture also
     * flips the mute flag — so they are the family that needs the explicit
     * start-time + reapply-window unmute, not just MagicOS.
     *
     * Deliberately excludes SAMSUNG / GENERIC (working HW AEC, proven WEE-54
     * generic path — acceptance criterion A5) and HUAWEI (its #874 symptom was
     * HW-AEC capture mute, fixed via [prefersSoftwareAudioProcessing]; no
     * mic-mute-flag report, so its routing path stays untouched).
     */
    private val AGGRESSIVE_MIC_MUTE_VENDORS = setOf(
        CallVendor.HONOR,
        CallVendor.REALME,
        CallVendor.OPPO,
        CallVendor.XIAOMI,
    )

    /**
     * Aggressive Chinese ROMs (HONOR MagicOS #872/#873, realme RealmeUI / OPPO
     * ColorOS / Xiaomi MIUI WEE-87 #993/#994/#995) — caller-only / one-way audio
     * because the global microphone-mute flag is left asserted.
     *
     * On these HALs the explicit `setCommunicationDevice` routing applied by
     * [AudioRouter.start] can leave the global microphone-mute flag asserted, so
     * the local capture path is silent and the peer hears nothing while the
     * caller hears themselves. An explicit `setMicrophoneMute(false)` after the
     * mode flip releases it, and the OEM mode-reapply window re-releases it on
     * each tick because these same ROMs re-assert the flag asynchronously after
     * setup (see [AudioRouter.shouldReapplyMicUnmute]).
     *
     * WEE-87: WEE-76 gated this to HONOR only, so the mirror-image one-way
     * reports on realme 12 (#994 — peer hears me, I don't) / realme C25s (#995 —
     * I hear, peer doesn't) and the both-way silence on 1.10.40 (#993) slipped
     * through. Extending to the ColorOS/RealmeUI/MIUI family closes that gap.
     *
     * Still gated (not applied everywhere on *start*) because the proven generic
     * WEE-54 path must stay byte-for-byte unchanged on the working majority
     * (Samsung / Pixel / OnePlus / unknown OEMs — A5); the post-call reset
     * ([shouldUnmuteMicOnStop]) is what defensively covers every other vendor.
     * Re-asserting the unmute is itself safe (it can only release a stuck
     * capture path, never break a healthy one), so this gate is about avoiding
     * needless mid-call AudioManager churn on devices that never exhibit the bug.
     */
    fun requiresExplicitMicUnmuteOnStart(vendor: CallVendor): Boolean =
        vendor in AGGRESSIVE_MIC_MUTE_VENDORS

    /**
     * Post-call defensive microphone unmute for **every** vendor
     * (#875 / #898 / #900 + the cross-app "Telegram voice message is empty
     * after a Forta call" report).
     *
     * `AudioManager.setMicrophoneMute` toggles a process-global flag. If any
     * path left it asserted when the call tears down, other apps
     * (Telegram / WhatsApp / system recorder) capture pure silence until
     * reboot. Clearing it on every teardown is universally safe — it can only
     * release a stuck capture path, never break a healthy one — so the policy
     * is vendor-independent and always true. Kept as a predicate (rather than a
     * bare call site) so the intent is documented and locked by a test.
     */
    fun shouldUnmuteMicOnStop(vendor: CallVendor): Boolean = true

    /**
     * Whether the WebRTC factory should use **software** AEC/NS for this device
     * instead of the hardware path. See [BROKEN_HW_AEC_VENDORS].
     *
     * This is the root-cause handling for the HUAWEI "video works, no audio"
     * symptom (#874): EMUI hardware AEC mutes the capture stream, so the video
     * pipeline is fine while audio is dropped. We deliberately do NOT force a
     * PCMU/G.711 codec fallback (as one hypothesis suggested) — disabling Opus
     * would degrade quality for every Huawei user and risk one-way audio
     * against Opus-only web/desktop peers (an A5 regression). Falling back to
     * software audio processing fixes the capture mute without touching codec
     * negotiation.
     *
     * Matches manufacturer OR brand (case-insensitive, whitespace-trimmed),
     * mirroring the prior `NativeWebRTCManager` predicate. One intentional
     * tightening: that predicate returned false whenever `Build.MANUFACTURER`
     * was null, ignoring the brand; this one falls back to the brand, so a
     * device exposing the vendor only via `Build.BRAND` still gets the software
     * fallback. Real production builds populate both fields, so the difference
     * is observable only on emulator / malformed-ROM builds — and there the
     * brand-aware answer is the safer one.
     */
    fun prefersSoftwareAudioProcessing(manufacturer: String?, brand: String?): Boolean {
        val m = manufacturer?.trim()?.lowercase().orEmpty()
        val b = brand?.trim()?.lowercase().orEmpty()
        if (m.isEmpty() && b.isEmpty()) return false
        // WEE-60: substring match, not strict equality. detect() above already
        // uses contains(); this predicate lagged behind with `==`, so OEMs that
        // report a multi-word Build.MANUFACTURER/BRAND (e.g. "Infinix Mobility
        // Limited", "TECNO MOBILE LIMITED", brand "Itel it2163") never matched
        // and kept the broken hardware AEC — muting the capture path into
        // one-way audio (#894 Xiaomi 12X, #921 Pixel-adjacent reports).
        return BROKEN_HW_AEC_VENDORS.any { v -> m.contains(v) || b.contains(v) }
    }
}
