import { ref, computed } from "vue";

export type BootStep =
  | "scripts"
  | "tor"
  | "auth"
  | "matrix"
  | "sync"
  | "ready";

export type BootState = "booting" | "ready" | "error";

/**
 * Discriminator for typed boot errors so the loading UI can choose
 * an appropriate copy + retry affordance instead of a generic banner.
 *
 *  - `matrix-unreachable`: Matrix homeserver did not become ready within the
 *    retry budget (timeouts, repeated transport failures, MIUI killing the
 *    long-poll /sync etc.). See WEE-46.
 *  - `generic`: any other boot-time failure.
 */
export type BootErrorKind = "matrix-unreachable" | "generic";

const _bootStart = Date.now();
const _stepStartedAt = ref(_bootStart);
const _currentStep = ref<BootStep>("scripts");
const _state = ref<BootState>("booting");
const _errorMessage = ref<string | null>(null);
const _errorKind = ref<BootErrorKind | null>(null);

function elapsed(): number {
  return Date.now() - _stepStartedAt.value;
}

export const bootStatus = {
  state: computed(() => _state.value),
  currentStep: computed(() => _currentStep.value),
  error: computed(() => _errorMessage.value),
  errorKind: computed(() => _errorKind.value),

  /** Advance to the next boot step. Logs timing of the previous step. */
  setStep(step: BootStep) {
    if (_state.value !== "booting") return;
    console.log(`[BOOT] ${_currentStep.value} done in ${elapsed()}ms → ${step}`);
    _currentStep.value = step;
    _stepStartedAt.value = Date.now();
  },

  /** Mark boot as successfully completed. */
  setReady() {
    if (_state.value !== "booting") return;
    const total = Date.now() - _bootStart;
    console.log(`[BOOT] ${_currentStep.value} done in ${elapsed()}ms`);
    console.log(`[BOOT] ✓ App ready (total ${total}ms)`);
    _state.value = "ready";
    _currentStep.value = "ready";
  },

  /**
   * Mark boot as failed. Shows error UI in AppLoading.
   *
   * @param msg  Human-readable diagnostic. Surfaced in the generic banner copy.
   * @param kind Optional classification used by AppLoading to pick a typed copy
   *             and retry CTA. Defaults to `"generic"` for backward compat.
   */
  setError(msg: string, kind: BootErrorKind = "generic") {
    // Guard symmetrical with `setStep` / `setReady`: once the boot has already
    // resolved (ready or errored), a second call must not silently overwrite
    // the first verdict (e.g. an account-switch race during a long retry
    // window flipping `errorKind` from `"matrix-unreachable"` back to
    // `"generic"`).
    if (_state.value !== "booting") return;
    console.error(
      `[BOOT] ✗ Error at step "${_currentStep.value}" (${kind}): ${msg}`,
    );
    _state.value = "error";
    _errorMessage.value = msg;
    _errorKind.value = kind;
  },

  /** Reset to initial state (for retry). */
  reset() {
    _currentStep.value = "scripts";
    _state.value = "booting";
    _errorMessage.value = null;
    _errorKind.value = null;
    _stepStartedAt.value = Date.now();
  },
};
