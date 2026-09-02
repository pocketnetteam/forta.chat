# Registration: Trust the Actions SDK's Own Transaction Engine

**Goal:** Stop duplicating work the vendor Actions SDK already does autonomously (broadcasting the `userInfo` action, watching for incoming PKOIN, re-checking confirmation) and shrink `stores.ts`'s registration poll down to only the parts with no SDK equivalent: collision-safety across our own retry entry points, and product UX (bounded timeout, cancel button, progress signal).

**Architecture:** No new modules. Split the existing `poll()` tick in `stores.ts` into "kick the SDK once" (on `register()`/`retryRegistration*()` entry only) vs. "observe status" (every subsequent tick, read-only). Keep every product-level and Forta-specific piece (`PollTimer`, 30-min timeout, 10-min cancel, key republish, username-taken handling) untouched.

**Tech Stack:** Vue 3 + Pinia + TypeScript, vendor Actions SDK (`public/js/lib/client/actions.js`, non-npm, loaded as a global `Actions`/`Api`/`pSDK`), Vitest.

**Non-goal:** This plan does **not** touch `blockchain-ws` (`src/shared/lib/blockchain-ws/`) beyond an investigation task (Task 6) — it also drives wallet refresh and Pcrypto block height, and must not be ripped out casually. It does not touch `verifyAndRepublishKeys`, `likelyBastyonUser`, captcha/UI stubs in `pocketnetinstance.ts`, or the RegistrationStepper UI — those are product decisions, not SDK-gap workarounds (see "Invariants" below).

---

## Context for Implementor

### Why this plan exists

The registration poll in `stores.ts` was built under the assumption that `addActionAndSendIfCan` (the vendor call used to broadcast the `userInfo` registration action) does nothing useful for a brand-new, not-yet-registered account — it only *queues* the action and resolves immediately with no txid, because `checkAccountReadySend()` requires `status.value` (already registered). That assumption is only half true.

Reading the actual vendor source (`public/js/lib/client/actions.js`, confirmed identical in the relevant sections to the canonical upstream copy at `C:\inetpub\wwwroot\pocketnet\js\lib\client\actions.js`) shows a **second, independent code path**:

```js
// actions.js — Account.processing(), driven by Actions.init()'s own setInterval(…, 3000)
self.processing = async function(){
    if(processing) return
    self.checkWillChangeUnspents()
    if(self.waitUserAction) { return }
    if(!self.isCurrentNetwork()) return
    var sorted = _.sortBy(self.actions.value, (action) => { return action.priority })
    processing = processArray(sorted, (action) => {
        return action.processingWithIteractions().catch(e => { return Promise.resolve() })
    }).finally(() => { setTimeout(() => { processing = null }, 1000) })
}
```

This iterates every queued action **unconditionally** — no `checkAccountReadySend()` gate. And the `userInfo` action type is specifically exempted from the "must already be registered" check:

```js
// actions.js — userInfo action-type definition
userInfo : {
    change : function(action, account){
        if (action.transaction){ account.willChange = true }
        if (action.completed){ account.willChange = false; account.status.value = true }
    },
    sendWithNullStatus : true,   // <-- bypasses the account.status.value gate for THIS action type
    priority : 1
},
```

```js
// actions.js — Action.processing(), the gate sendWithNullStatus bypasses
if (!account.status.value){
    if(!options.sendWithNullStatus) {
        return Promise.reject('actions_waitUserStatus')
    }
}
```

`app-initializer.ts:150-151` already calls `this.actions.init()`, which starts that 3-second interval. So **the interval is already running in production** — every existing forced `processingWithIteractions()` call from `ensureActionBroadcast` is racing (and usually winning, by up to 3s) against work the SDK would have done on its own anyway.

The SDK also autonomously tracks incoming coins (WS push `Account.ws.transaction/block`, RPC fallback `updateUnspents()`) and autonomously re-checks a sent transaction's confirmation (`checkConfirmationUntil`, ~65s cadence) — both inside the same `Account.processing()` loop.

The reference implementation (`C:\inetpub\wwwroot\pocketnet\components\test\index.js:236-364`) leans on exactly this: it calls `addActionAndSendIfCan(userInfo).then/catch/finally` **once**, with no retry loop, no backoff, no timeout, no status polling of its own.

### What forta.chat's poll is actually still needed for

Not "make the SDK send the transaction" — it already will, within ≤3s, on its own. What forta.chat's poll uniquely provides, with no SDK equivalent:

1. **A bounded timeout with user-facing error UI.** The SDK retries forever, silently. Product requires: give up after 30 min active time and show an error (`stores.ts:278, 1765-1771`).
2. **A cancel button after 10 min** (`stores.ts:279, 283-288`) — no SDK concept.
3. **Active-time tracking (`PollTimer`)** so Android WebView background-throttling doesn't fire the timeout instantly on resume (`entities/auth/lib/poll-timer.ts`).
4. **Collision-safety across our OWN retry call sites.** `startRegistrationPoll()` is called from 4 places (`register`, `retryRegistrationWithNewName`, `retryRegistration`, `resumeRegistrationPoll`) — calling `addActionAndSendIfCan` twice for the same address queues a *second* action, and the SDK's own collision guard rejects one with `actions_collision`. This is a problem **we** create by having multiple retry entry points, not a gap in the SDK.
5. **Progress UI** (`registrationPollAttempt`, 3-step stepper).
6. **Username-taken (code 18) detection + `retryRegistrationWithNewName`.**
7. **Forta-specific key republish** (`verifyAndRepublishKeys`) — orthogonal to this plan.

Everything in this list survives this plan unchanged. What changes: **the poll tick stops re-forcing a broadcast on every iteration** and becomes a pure status observer after the first tick, because the SDK's own interval is already handling redelivery.

### Key files

| File | Lines | Role |
|---|---|---|
| `src/entities/auth/model/stores.ts` | 1603-1652 (`register`), 1690-2047 (`startRegistrationPoll`/poll/`onRegistrationConfirmed`), 2049-2152 (`stopRegistrationPoll`/`cancelRegistration`/`retryRegistration`/`resumeRegistrationPoll`) | Registration state machine |
| `src/app/providers/initializers/app-initializer.ts` | 99-158 (constructor, `actions.init()`), 319-436 (`registerUserProfile`/`broadcastUserInfoAction`/`pendingUserInfoActions`), 1083-1123 (`getAccountRegistrationStatus`/`checkUserRegistered`) | Bridge to vendor Actions SDK |
| `src/entities/auth/lib/ensure-action-broadcast.ts` | whole file | Forces `processingWithIteractions` instead of waiting up to 3s for the SDK's own interval |
| `src/entities/auth/lib/poll-timer.ts` | whole file | Active-time tracking — unaffected by this plan |
| `public/js/lib/client/actions.js` | 98-114 (`userInfo` type), 1144-1154 (confirmation recheck), 1197-1201 (`sendWithNullStatus` gate), 2244-2263 (`updateUnspents`), 2315-2335 (`Account.ws`), 2402-2436 (`Account.processing`), 2438 (`checkAccountReadySend`), 2849-2892 (`addActionAndSendIfCan`), 2970-3025 (`Actions.init`, the 3s interval) | Vendor SDK (read-only reference, do not edit) |

### Invariants — do NOT change these in any task below

- `platform.ui.support`/`platform.ui.edituserinfo` stay rejected (`pocketnetinstance.ts:96-105`) — chat has no support-ticket UI and no in-place username-change modal, and nothing in either track needs them.
- `platform.ui.captcha` is the one exception: **Track B below replaces its reject-stub with a real implementation** — see that section. Everything else in this file (Track A) leaves it untouched.
- No wallet-address rotation (`pocketnetinstance.ts:83-88`).
- `verifyAndRepublishKeys`/`resolveKeyRepublishAction`/`likelyBastyonUser` (`stores.ts:1179-1348`) — Forta-specific invariant, not an SDK concern.
- RegistrationStepper's 3-step UI and progress signals (`registrationPollAttempt`, `registrationPollElapsedMs`) keep the same external contract.
- 30-min timeout / 10-min cancel thresholds (`REGISTRATION_POLL_TIMEOUT`, `REGISTRATION_CANCEL_AFTER_MS`) stay as-is unless product explicitly asks to change them.

---

## Track A: trust the polling/broadcast engine

## Task 1: Baseline telemetry + feature flag

**Files:**
- Modify: `src/entities/auth/model/stores.ts` (top of file, near other module-level consts)
- Create: `src/entities/auth/lib/registration-flags.ts`

**Step 1: Write the failing test**

Create: `src/entities/auth/lib/__tests__/registration-flags.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { isTrustSdkEngineEnabled, setTrustSdkEngine } from "../registration-flags";

describe("registration-flags", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to disabled", () => {
    expect(isTrustSdkEngineEnabled()).toBe(false);
  });

  it("can be toggled and persists across reads", () => {
    setTrustSdkEngine(true);
    expect(isTrustSdkEngineEnabled()).toBe(true);
  });
});
```

Run: `npx vitest run src/entities/auth/lib/__tests__/registration-flags.test.ts` → expect FAIL (module doesn't exist yet).

**Step 2: Implement the flag**

Create `src/entities/auth/lib/registration-flags.ts`:

```typescript
const FLAG_KEY = "forta_registration_trust_sdk_engine";

/** Feature flag for the registration-poll rework (2026-08-29 plan).
 *  When true, startRegistrationPoll() force-broadcasts only on its first
 *  tick and treats every subsequent tick as a read-only status observer,
 *  trusting the Actions SDK's own 3s Account.processing() interval to
 *  redeliver the queued userInfo action. When false (default), keeps the
 *  original behavior of forcing a broadcast attempt on every tick. */
export function isTrustSdkEngineEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === "true";
  } catch {
    return false;
  }
}

export function setTrustSdkEngine(enabled: boolean): void {
  try {
    localStorage.setItem(FLAG_KEY, enabled ? "true" : "false");
  } catch {
    /* ignore — storage unavailable */
  }
}
```

**Step 3: Add source-tagged logging**

In `src/app/providers/initializers/app-initializer.ts`, inside `broadcastUserInfoAction` (around line 412-417), tag which path actually produced the queued action:

```typescript
    const queued = (await this.actions!.addActionAndSendIfCan(
      userInfo,
      null,
      address,
    )) as BroadcastableAction;
    this.pendingUserInfoActions.set(address, queued);
    console.info("[appInit][reg-telemetry] userInfo queued, has txid already:", !!queued.transaction);
```

And in `ensure-action-broadcast.ts`, log whether the forced call or the ambient state already had a result:

```typescript
  if (action.transaction || action.completed) {
    console.info("[ensureActionBroadcast][reg-telemetry] already had outcome before forcing — SDK interval likely won the race");
    return action;
  }
  // ... existing code ...
  if (typeof action.processingWithIteractions === "function") {
    console.info("[ensureActionBroadcast][reg-telemetry] forcing processingWithIteractions");
    try {
      await action.processingWithIteractions(true);
```

**Step 4: Verify**

Run: `npx vitest run src/entities/auth/lib/__tests__/registration-flags.test.ts` → PASS.
Manually register a test account on dev, confirm both log lines appear in the console with the expected `reg-telemetry` tag.

---

## Task 2: Regression test for the collision guard (lock in current safety before refactoring)

**Files:**
- Create: `src/app/providers/initializers/__tests__/registration-double-retry-collision.test.ts`

**Step 1: Write the test**

This test locks in the *existing* protection (`pendingUserInfoActions` map) before Task 3 touches the calling code around it, so a regression is caught immediately.

```typescript
import { describe, it, expect, vi } from "vitest";
import { AppInitializer } from "../app-initializer";

describe("registration: rapid double register() does not double-queue userInfo", () => {
  it("reuses the same pending action across two broadcastUserInfoAction calls for the same address", async () => {
    const addActionAndSendIfCan = vi.fn().mockResolvedValue({
      transaction: null,
      completed: false,
      processingWithIteractions: vi.fn().mockResolvedValue(undefined),
    });

    // Minimal fake pocketnetInstance/Actions global wiring — mirrors the
    // pattern used in existing app-initializer tests (see
    // broadcast-userinfo-action-reuse.test.ts for the established fixture).
    const appInit = new AppInitializer({
      options: { listofproxies: [] },
    } as any);
    (appInit as any).actions = {
      addActionAndSendIfCan,
      addAccount: () => ({ loadUnspents: async () => {} }),
    };
    (appInit as any)._available = true;

    const profile = { name: "alice", language: "en", about: "" };
    const address = "PAliceTestAddress";

    // Fire two concurrent registration attempts for the same address —
    // simulates a double-click or a retry racing the original call.
    await Promise.all([
      appInit.registerUserProfile(address, profile, ["k1"]).catch(() => {}),
      appInit.registerUserProfile(address, profile, ["k1"]).catch(() => {}),
    ]);

    // The SDK's addActionAndSendIfCan must be called exactly once — the
    // second call must reuse the pending action instead of re-queuing.
    expect(addActionAndSendIfCan).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run and confirm PASS against current code**

Run: `npx vitest run src/app/providers/initializers/__tests__/registration-double-retry-collision.test.ts`

This should already pass against the *current* `broadcastUserInfoAction` implementation (it's the exact behavior `pendingUserInfoActions` already provides). If it fails, stop — that means the existing guard is already broken and must be fixed before proceeding to Task 3, not after.

---

## Task 3: Force-broadcast once, then observe — the core change

**Files:**
- Modify: `src/entities/auth/model/stores.ts:1752-1919` (the `poll` closure inside `startRegistrationPoll`)

**Step 1: Write the failing test**

Create: `src/entities/auth/model/__tests__/registration-poll-trust-sdk.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("registration poll — trust-SDK mode (flag on)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.setItem("forta_registration_trust_sdk_engine", "true");
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("calls registerUserProfile (force-broadcast) at most once across repeated Phase-1 ticks", async () => {
    // Source-level assertion mirrors the style of the existing
    // registration-poll.test.ts — verifies the guard exists in code,
    // since the poll closure is not exported for direct unit testing.
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../stores.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8",
    );
    expect(source).toContain("hasForcedBroadcastThisLoop");
  });
});
```

Run: `npx vitest run src/entities/auth/model/__tests__/registration-poll-trust-sdk.test.ts` → FAIL (flag/guard don't exist yet).

**Step 2: Implement — gate the force-broadcast to the first tick only**

In `stores.ts`, inside `startRegistrationPoll` (around line 1698-1712), add a per-loop flag next to the existing `pollInFlight`:

```typescript
  const startRegistrationPoll = () => {
    if (registrationPollTimer) clearTimeout(registrationPollTimer);
    const myGeneration = ++registrationPollGeneration;
    let pollInterval = 3000;
    const MAX_POLL_INTERVAL = 60000;
    let attempt = 0;
    pollTimer = new PollTimer();
    registrationPollAttempt.value = 0;
    let consecutiveErrors = 0;
    let pollInFlight = false;
    // Trust-SDK mode (see registration-flags.ts): force a real broadcast
    // attempt only on the FIRST tick of Phase 1 for this loop. The Actions
    // SDK's own 3s Account.processing() interval (started by actions.init()
    // in app-initializer.ts) redelivers the queued userInfo action on its
    // own afterward — forcing it again on every tick just re-races the same
    // work the SDK is already doing. Off by default (see Task 1's flag);
    // when off, behaves exactly as before this plan.
    const trustSdkEngine = isTrustSdkEngineEnabled();
    let hasForcedBroadcastThisLoop = false;
```

Then in Phase 1 of `poll()` (around line 1786-1872), change the broadcast call to skip when trust-mode has already forced once:

```typescript
          if (pendingRegProfile.value) {
            // ... existing rawProfiles / hasUnspents checks unchanged ...

            if (hasUnspents) {
              const shouldForceBroadcast = !trustSdkEngine || !hasForcedBroadcastThisLoop;
              if (shouldForceBroadcast) {
                console.log("[auth] PKOIN received, broadcasting UserInfo (forced)...");
                setRegistrationPhase('broadcasting');
                try {
                  await withTimeout(appInitializer.syncNodeTime(), RPC_CALL_TIMEOUT, "syncNodeTime");
                  const { encPublicKeys, image, ...profile } = pendingRegProfile.value;
                  await withTimeout(
                    appInitializer.initializeAndFetchUserData(address.value, undefined, { update: true }),
                    RPC_CALL_TIMEOUT,
                    "initializeAndFetchUserData",
                  );
                  if (myGeneration !== registrationPollGeneration) return;

                  const { registrationNode } = await appInitializer.registerUserProfile(address.value, profile, encPublicKeys, image);
                  registrationFnode = registrationNode;
                  hasForcedBroadcastThisLoop = true;
                  console.log("[auth] UserInfo broadcast requested, moving to phase 2 (fnode:", registrationFnode, ")");
                  setRegistrationPhase('confirming');
                  setPendingRegProfile(null);
                  pollInterval = 3000;
                  attempt = 0;
                } catch (broadcastErr: unknown) {
                  const errCode = extractErrorCode(broadcastErr);
                  if (errCode === 18) {
                    console.error("[auth] UserInfo broadcast rejected: username taken/invalid (code 18)");
                    setRegistrationPhase('error');
                    registrationUsernameError.value = true;
                    setRegistrationPending(false);
                    stopRegistrationPoll();
                    return;
                  }
                  // In trust-SDK mode a broadcast failure on the forced
                  // attempt is not fatal — mark it forced anyway and let the
                  // SDK's own interval keep retrying via getAccountRegistrationStatus()
                  // in Phase 2 below; only rethrow (→ counted as a poll error)
                  // in the legacy per-tick-force mode.
                  if (trustSdkEngine) {
                    hasForcedBroadcastThisLoop = true;
                    console.warn("[auth] forced broadcast failed, deferring to SDK interval:", broadcastErr);
                  } else {
                    throw broadcastErr;
                  }
                }
              } else {
                // Trust-SDK mode, already forced once this loop: PKOIN is
                // present and the action is queued — the SDK's own interval
                // owns redelivery from here. Just fall through to Phase 2's
                // status read on the next tick instead of re-forcing.
                console.log("[auth] PKOIN present, SDK interval owns redelivery — moving to status watch");
                setRegistrationPhase('confirming');
                setPendingRegProfile(null);
              }
            } else {
              console.log("[auth] Waiting for PKOIN... (attempt", attempt, ", next in", pollInterval / 1000, "s)");
            }
            consecutiveErrors = 0;
            schedulePoll();
            return;
          }
```

**Step 3: Run test to verify it passes**

Run: `npx vitest run src/entities/auth/model/__tests__/registration-poll-trust-sdk.test.ts` → PASS.

**Step 4: Run full existing suite to check for regressions**

Run: `npx vitest run src/entities/auth/model/__tests__/registration-poll.test.ts src/app/providers/initializers/__tests__/registration-rpc-timeout.test.ts src/app/providers/initializers/__tests__/broadcast-userinfo-action-reuse.test.ts`

All must stay green — the flag defaults to `false`, so legacy behavior (force on every tick) must be provably unchanged when the flag is off. Any red test here is a signal the refactor leaked into the legacy path; fix before proceeding.

---

## Task 4: Replace the `undefined_status` guess with a documented status table

**Files:**
- Modify: `src/entities/auth/model/stores.ts:1874-1886` (Phase 2 of `poll()`)

**Step 1: Write the failing test**

Create: `src/entities/auth/model/__tests__/registration-status-mapping.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { isRegistrationConfirmedStatus } from "../../lib/registration-status";

describe("isRegistrationConfirmedStatus", () => {
  it("treats 'registered' as confirmed", () => {
    expect(isRegistrationConfirmedStatus("registered")).toBe(true);
  });

  it("treats 'undefined_status' as confirmed (documented SDK race, see actions.js Account.getStatus)", () => {
    expect(isRegistrationConfirmedStatus("undefined_status")).toBe(true);
  });

  it("does NOT treat known in-progress states as confirmed", () => {
    expect(isRegistrationConfirmedStatus("in_progress_transaction")).toBe(false);
    expect(isRegistrationConfirmedStatus("in_progress_hasUnspents")).toBe(false);
    expect(isRegistrationConfirmedStatus("in_progress_wait_unspents")).toBe(false);
    expect(isRegistrationConfirmedStatus("not_in_progress")).toBe(false);
    expect(isRegistrationConfirmedStatus("not_in_progress_no_processing")).toBe(false);
    expect(isRegistrationConfirmedStatus("not_available")).toBe(false);
  });
});
```

Run: FAIL (module doesn't exist).

**Step 2: Implement — extract the mapping into a named, tested function**

Create `src/entities/auth/lib/registration-status.ts`:

```typescript
/** Known return values of Actions.getCurrentAccount().getStatus()
 *  (actions.js Account.getStatus, ~line 2571) — mirrors Pocketnet's own
 *  user.userRegistrationStatus(). */
export type AccountRegistrationStatus =
  | "registered"
  | "in_progress_transaction"
  | "in_progress_hasUnspents"
  | "in_progress_wait_unspents"
  | "not_in_progress"
  | "not_in_progress_no_processing"
  | "not_available"
  // Observed but undocumented in the vendor source: the userInfo action's
  // `change` handler (actions.js ~line 105-112) sets `account.status.value =
  // true` only inside `if (action.completed)`, but `completed` and the
  // externally-visible getStatus() string can be read a tick apart — a
  // caller can observe a transaction that already has a txid/completed flag
  // before getStatus() has settled back to 'registered'. Treated as
  // confirmed here rather than spun on forever.
  | "undefined_status"
  | (string & {});

export function isRegistrationConfirmedStatus(status: AccountRegistrationStatus): boolean {
  return status === "registered" || status === "undefined_status";
}
```

In `stores.ts`, replace the inline check (lines 1878-1886):

```typescript
          const actionsStatus = appInitializer.getAccountRegistrationStatus();
          console.log("[auth] Registration poll — actions:", actionsStatus, "(attempt", attempt, ")");

          if (isRegistrationConfirmedStatus(actionsStatus)) {
            if (myGeneration !== registrationPollGeneration) return;
            console.log("[auth] Registration confirmed via Actions system!");
            await onRegistrationConfirmed();
            return;
          }
```

Add the import near the top of `stores.ts` alongside the other `../lib` imports:

```typescript
import { isRegistrationConfirmedStatus } from "../lib/registration-status";
```

**Step 3: Verify**

Run: `npx vitest run src/entities/auth/model/__tests__/registration-status-mapping.test.ts` → PASS.
Run: `npx vitest run src/entities/auth/model/__tests__/registration-poll.test.ts` → still green (behavior identical, just extracted).

**Note:** this task is a pure refactor (extract + document), not a behavior change — it does not depend on the `trustSdkEngine` flag and can ship independently of Task 3.

---

## Task 5: Reduce backoff aggressiveness once Task 3 is confirmed safe (flag-gated)

**Files:**
- Modify: `src/entities/auth/model/stores.ts:1921-1924` (`schedulePoll`)

**Do this task only after Task 3 has been running on staging for at least a few real registrations** (see Task 7) — it changes network call cadence, which is the thing most likely to surface a proxy-load regression.

**Step 1: Write the failing test**

Extend `registration-poll-trust-sdk.test.ts`:

```typescript
  it("uses a flatter backoff ceiling in trust-SDK mode", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      new URL("../stores.ts", import.meta.url).pathname.replace("/__tests__", ""),
      "utf-8",
    );
    expect(source).toContain("TRUST_SDK_MAX_POLL_INTERVAL");
  });
```

**Step 2: Implement**

```typescript
    let pollInterval = 3000;
    // In trust-SDK mode this loop only reads status — it's cheap, so cap
    // backoff lower (mirrors the SDK's own ~3s cadence) instead of growing
    // to 60s, while still backing off from the initial 3s so we don't spam
    // getAccountRegistrationStatus() faster than the SDK itself updates it.
    const MAX_POLL_INTERVAL = trustSdkEngine ? TRUST_SDK_MAX_POLL_INTERVAL : 60000;
```

Add the constant near the other registration constants (line ~278-281):

```typescript
  const TRUST_SDK_MAX_POLL_INTERVAL = 8_000; // trust-SDK mode: status-only reads, cheap to poll more often
```

**Step 3: Verify**

Run the trust-SDK test file plus `registration-poll.test.ts` — both green. Confirm via Task 1's telemetry on staging that RPC call volume for `getAccountRegistrationStatus`/`checkUserRegistered` doesn't spike unacceptably (it's a local Actions-object read plus an occasional `getuserstate` RPC, not a heavy call — but verify against real proxy logs if available before enabling on production traffic).

---

## Task 6: Investigate `blockchain-ws` vs. the SDK's own `Account.ws` (research only — no code change)

**Files:** none modified — this task produces a written finding, not a diff.

**Step 1:** Using Task 1's telemetry (extend it if needed — log a timestamp on every `onTransaction`/`onBlock` callback in `stores.ts:880-909` and, separately, patch a temporary `console.info` into `Account.ws.transaction`/`.block` in the vendored `public/js/lib/client/actions.js` for a local dev build only — **do not ship a modified vendor file**), capture timestamps from a handful of real dev registrations for both event sources.

**Step 2:** Compare: does `blockchain-ws`'s event consistently arrive before, after, or simultaneously with the SDK's own `Account.ws` event for the same transaction?

**Step 3:** Write the finding as a short addendum to this file's "Findings" section (below) — do NOT act on it as part of this plan. Possible outcomes:
- If `blockchain-ws` has no latency advantage: file a **separate** follow-up plan to evaluate removing the duplicate subscription (scoped separately because `blockchain-ws` also feeds `scheduleWalletRefreshFromChain` and `pcrypto.setBlock`, which are out of scope here).
- If `blockchain-ws` is measurably faster (e.g. different node set, lower-latency transport): document why and close this investigation with "keep as-is."

### Findings (fill in after running Task 6)

_(leave this section for whoever executes Task 6 to fill in with real numbers — do not guess)_

---

## Task 7: Test matrix + staged rollout

**Step 1: Full verification per CLAUDE.md before any merge**

```bash
npm run build
npx vue-tsc --noEmit
npm run test
```

Then `/code-review high` on the diff (registration is a critical, hard-to-manually-test-in-CI flow — use `high`, not `low`/`medium`, per CLAUDE.md's scale guidance).

**Step 2: Manual scenarios on dev with `setTrustSdkEngine(true)`**

Run each of these by hand, checking the `reg-telemetry` logs from Task 1 confirm the expected source (`sdk-interval` winning vs. `forced-broadcast`):

1. Cold registration, network stays up the whole time.
2. Registration, then background the app (Android) for >1 min before PKOIN arrives — confirm `PollTimer` still counts only active time and the poll resumes correctly on foreground.
3. Registration with an already-taken username → `retryRegistrationWithNewName` → confirm no double-queue (Task 2's collision guard still holds with `trustSdkEngine` on).
4. Kill and reopen the app mid-registration → `resumeRegistrationPoll()` picks the loop back up correctly in trust-SDK mode.
5. Force a timeout (mock a stuck confirming phase, or wait out 30 min on a throwaway account) → error UI and cancel button still behave identically to the flag-off path.

**Step 3: Staged flag rollout**

1. Enable for dev builds only — validate Step 2's scenarios.
2. Enable on an internal/staging build — observe Task 1's telemetry for a minimum of several days of real registrations. Look specifically for: any registration that *never* got a `sdk-interval`-sourced outcome (would indicate the SDK's interval isn't actually running for some environment — investigate `actions.init()` before going further), and any collision-guard trip (`actions_collision` in logs).
3. Roll out to production once staging shows the SDK-interval path consistently producing outcomes with no increase in error rate vs. the flag-off baseline.
4. Keep the flag (and the pre-Task-3 code path) available for at least one full release cycle after production rollout, in case of a rollback need.

---

## Task 8: Cleanup (only after Task 7's production rollout is confirmed stable)

**Files:**
- Modify: `src/entities/auth/model/stores.ts`
- Modify: `src/entities/auth/lib/ensure-action-broadcast.ts`
- Delete: `src/entities/auth/lib/registration-flags.ts` (and its test) once the flag is permanent-on
- Modify: `src/app/providers/initializers/__tests__/registration-rpc-timeout.test.ts` and other tests referencing the legacy per-tick-force path, if any assert on call counts that change once the flag path becomes the only path

**Step 1:** Remove the `trustSdkEngine`/`hasForcedBroadcastThisLoop` branching, making the Task 3 "force once" behavior unconditional (delete the `else` branch that re-forces every tick).

**Step 2:** Remove `isTrustSdkEngineEnabled`/`setTrustSdkEngine` and their test file; remove the flag check from `startRegistrationPoll`.

**Step 3:** Update the doc comment on `ensure-action-broadcast.ts` to describe it accurately going forward — it is a **latency optimization for the first broadcast attempt**, not a workaround for a missing SDK capability:

```typescript
/** Force the first broadcast attempt for a queued Actions SDK action instead
 *  of waiting for the SDK's own ~3s Account.processing() interval to pick it
 *  up. Also converts the SDK's ambiguous "queued, no txid yet" resolution
 *  into a concrete outcome (txid / completed / rejected) so callers cannot
 *  mistake a merely-queued action for success.
 *
 *  NB: the vendor method is spelled `processingWithIteractions` (actions.js —
 *  not a typo we get to fix, it's the real name on the object at runtime).
 */
```

**Step 4:** Run full verification (`npm run build`, `npx vue-tsc --noEmit`, `npm run test`, `/code-review high`) one final time on the cleanup diff.

---

## Track B: route captcha through `platform.ui.captcha` instead of hand-rolled RPC orchestration

**Hard constraint, checked twice now: zero visual/UX change.** `CaptchaStep.vue`'s template — markup, Tailwind classes, spinner, wizard position (step 2 of 3), the `RegisterForm.vue` step count and progress bar — stays **byte-for-byte identical**. This track only changes which function-call chain populates that unchanged template's reactive state: today it's three manual RPC calls (`fetchCaptcha`/`submitCaptcha`/`requestFreeRegistration`); after this track it's the vendor SDK's own `Account.requestUnspents()` → `solveCaptcha()` → `platform.ui.captcha()`, invoked at the exact same point in the flow (`CaptchaStep.vue`'s `onMounted`).

An earlier draft of this section got this wrong twice, corrected here:
1. It introduced a new floating `CaptchaModal.vue` with its own hand-rolled `bg-black/40` backdrop and `z-[60]` — a different visual chrome than the app's actual shared modal (`shared/ui/modal/Modal.vue`: `bg-background-overlay`, `z-50`, `rounded-xl bg-background-total-theme p-6 shadow-xl`, `Teleport`-to-body, focus trap, Android back-button handling via `useAndroidBackHandler`). Wrong either way — see point 2, the fix isn't "reuse `Modal.vue`" either.
2. It moved captcha out of the 3-step wizard into an overlay that pops up on top of the full-screen `RegistrationStepper` mid-registration — a real flow change (when/where the user sees the captcha), not just a chrome mismatch.

The fix for both: **don't render anything new at all.** `platform.ui.captcha`'s only contract is a function returning a `Promise` (see Task B2) — nothing requires it to open a modal. It can just update a plain reactive object that the *existing, unmodified* `CaptchaStep.vue` template already displays, because that template was already driven by reactive refs (`captchaSvg`, `captchaText`, `loading`, `error`) populated from an async call in `onMounted` — we're only swapping what that async call is.

### Why this is possible (traced end-to-end in the vendor SDK, not guessed)

Today, `register()` (`stores.ts:1603-1652`) manually replicates — before any `Actions`/`Account` object for the address is even touched — exactly what the vendor SDK does internally when it discovers an unfunded address:

| forta.chat (manual) | vendor SDK (automatic) |
|---|---|
| `findRegistrationProxy()` → `ProxyRotator` → `appInitializer.getRegistrationProxy()` | `Account.requestUnspents()` → `parent.api.get.proxywithwalletls()` |
| `fetchCaptcha()` → `appInitializer.getCaptcha(proxyId, captchaId)` | `Account.solveCaptcha()` → `platform.ui.captcha(reason, clbk, proxyOptions)` → (inside the real vendor implementation, `js/satolist.js:3636-3724`) → `self.sdk.captcha.get(...)` → RPC `'captcha'` |
| `submitCaptcha(text)` → `appInitializer.solveCaptcha(proxyId, captchaId, text)` | same `platform.ui.captcha` modal → `self.sdk.captcha.make(text, angles, cb)` → RPC `'makecaptcha'` |
| `appInitializer.requestFreeRegistration(address, captchaId, proxyId)` | `Account.requestUnspents()`'s `.then()` continuation → RPC `'free/balance'` with the solved captcha's `.id` |

Confirmed exact RPC parity: forta.chat's `appInitializer.getCaptcha`/`solveCaptcha` (`app-initializer.ts:257-295`) already call `fetchauth('captcha', {captcha: currentCaptchaId}, {proxy})` and `fetchauth('makecaptcha', {captcha, text, angles}, {proxy})` — **the identical two RPC methods and param shapes** the reference `self.sdk.captcha.get`/`.make` use (`js/satolist.js:12302-12441`). We are not missing an RPC capability; we are duplicating one that the SDK already owns end-to-end, driven by our own separate proxy/captcha state (`regProxyId`, `regCaptchaId`, `regCaptchaDone` in `stores.ts:222-224`).

**The trigger wiring is already half-built.** `Action.processingWithIteractions()` — the exact function `ensure-action-broadcast.ts` already force-calls — contains this (`actions.js:1266-1301`):

```js
self.processingWithIteractions = async function(rejectIfError){
    var error = null, tryresolve = false
    try{
        await self.processing()
    }
    catch(e){
        if (e == 'actions_rejectedFromNodes' || e == 'actions_noinputs' || self.controlReject(e)){
            tryresolve = true
        }
        error = e
    }
    if (error && tryresolve){
        error = await account.actionRejectedWithTriggers(self, error)   // <-- this is the chain
    }
    ...
    if(error) throw error
}
```

`account.actionRejectedWithTriggers` → `Account.actionRejected` (`actions.js:1617-1781`) — on `error == 'actions_noinputs'` (exactly what a brand-new, unfunded address's first send attempt produces) — calls `self.userInteractive(action, error, 'requestUnspents', {reason: 'registration'})` → `Account.requestUnspents()` → `Account.solveCaptcha()` → **`platform.ui.captcha(...)`**.

So: if `platform.ui.captcha` were a real implementation instead of `Promise.reject(new Error("captcha_ui_unavailable"))`, then simply queuing the `userInfo` action and force-broadcasting it via the **existing, unmodified** `ensureActionBroadcast`/`registerUserProfile` call — with NO prior PKOIN, before any manual proxy/captcha step — would already surface a real captcha modal at exactly the right moment, get it funded via `free/balance`, and (per `actions.js:1329`, `if(error) throw error` only fires when the *outer* error is non-null; a successful `actionRejectedWithTriggers` resolves `error = null` and the function returns normally without re-sending the transaction) fall through to our existing poll-retry loop to actually broadcast on the next tick, now that PKOIN exists. No change to the retry loop itself is required — Task 3 (Track A) or the current unmodified poll both already retry on a thrown "did not produce a transaction" error.

### Task B1: Headless captcha state bridge (no new component, no modal)

**Files:**
- Create: `src/entities/auth/lib/captcha-flow-bridge.ts`

**Deliberately not creating any `.vue` file here.** `platform.ui.captcha` only needs to return a `Promise` — it doesn't need to render anything itself. `CaptchaStep.vue` already exists, is already mounted at exactly the right point (wizard step 2), and already has reactive state (`captchaSvg`, `captchaText`, `loading`, `error`) driven from an `onMounted` async call. This bridge is just the reactive object that call will read from instead of calling `authStore.fetchCaptcha()` directly — it's plumbing, not UI.

**Step 1: Write the failing test**

Create: `src/entities/auth/lib/__tests__/captcha-flow-bridge.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { beginCaptchaFlow, captchaFlowState, configureCaptchaRpc } from "../captcha-flow-bridge";

describe("captcha-flow-bridge", () => {
  it("populates state and resolves when submit() is called with a solved captcha", async () => {
    configureCaptchaRpc({
      fetch: vi.fn().mockResolvedValue({ id: "cap1", img: "<svg/>", done: false }),
      solve: vi.fn().mockResolvedValue({ id: "cap1", done: true }),
    });

    const promise = beginCaptchaFlow("registration", { proxy: "proxy1" });
    expect(captchaFlowState.active).toBe(true);
    expect(captchaFlowState.reason).toBe("registration");

    await captchaFlowState.submit("ABCD");
    const result = await promise;
    expect(result.done).toBe(true);
    expect(captchaFlowState.active).toBe(false);
  });

  it("rejects with 'close' when cancel() is called", async () => {
    configureCaptchaRpc({
      fetch: vi.fn().mockResolvedValue({ id: "cap1", img: "<svg/>", done: false }),
      solve: vi.fn(),
    });

    const promise = beginCaptchaFlow("registration", { proxy: "proxy1" });
    captchaFlowState.cancel();
    await expect(promise).rejects.toBe("close");
  });
});
```

Run: FAIL (module doesn't exist).

**Step 2: Implement the bridge**

```typescript
// src/entities/auth/lib/captcha-flow-bridge.ts
import { reactive } from "vue";

type CaptchaFetchResult = { id: string; img?: string; done: boolean };
type CaptchaRpc = {
  fetch: (proxyId: string, currentCaptchaId?: string) => Promise<CaptchaFetchResult>;
  solve: (proxyId: string, captchaId: string, text: string) => Promise<CaptchaFetchResult>;
};

let rpc: CaptchaRpc | null = null;

/** Wired once during app init (see app-initializer.ts) — keeps this module
 *  free of a direct import of AppInitializer (which itself constructs the
 *  pocketnetInstance object this bridge is attached to — importing it here
 *  would be circular). Same pattern as PocketnetInstanceConfigurator. */
export function configureCaptchaRpc(impl: CaptchaRpc): void {
  rpc = impl;
}

interface CaptchaFlowState {
  active: boolean;
  reason: string;
  captchaId: string | null;
  img: string;
  submitting: boolean;
  error: string;
  submit: (text: string) => Promise<void>;
  refresh: () => Promise<void>;
  cancel: () => void;
}

/** Read directly by CaptchaStep.vue — see Task B3. No visual component
 *  owns this state; it's the same reactive-singleton pattern
 *  PocketnetInstanceConfigurator already uses for wiring
 *  window.POCKETNETINSTANCE.user.signature. */
export const captchaFlowState: CaptchaFlowState = reactive({
  active: false,
  reason: "",
  captchaId: null,
  img: "",
  submitting: false,
  error: "",
  submit: async () => {},
  refresh: async () => {},
  cancel: () => {},
});

/** Implements the vendor contract: Account.solveCaptcha calls
 *  `platform.ui.captcha(reason, registerComponentCallback, proxyOptions)`
 *  and expects a Promise<{id, done}>-shaped resolve, or a plain-string
 *  reject ('noproxy' | 'state' | 'network' | 'close' — see actions.js
 *  Platform.ui.captcha, js/satolist.js:3636-3724). We only need to honor
 *  the resolve/reject contract — proxy/state pre-checks are the caller's
 *  concern (Account.requestUnspents already resolved proxyOptions before
 *  calling us). */
export function beginCaptchaFlow(
  reason: string,
  proxyOptions: { proxy: string },
): Promise<CaptchaFetchResult> {
  if (!rpc) return Promise.reject("network");

  return new Promise((resolve, reject) => {
    const proxyId = proxyOptions.proxy;

    const load = async (refresh = false) => {
      captchaFlowState.submitting = false;
      captchaFlowState.error = "";
      try {
        const result = await rpc!.fetch(proxyId, refresh ? undefined : captchaFlowState.captchaId ?? undefined);
        captchaFlowState.captchaId = result.id;
        captchaFlowState.img = result.img ?? "";
        if (result.done) {
          // Auto-solved fast path (server already trusts this session) —
          // matches self.sdk.captcha.get's `d.result && !d.done` branch.
          end();
          resolve(result);
        }
      } catch {
        captchaFlowState.error = "load_failed";
      }
    };

    const end = () => {
      captchaFlowState.active = false;
    };

    captchaFlowState.active = true;
    captchaFlowState.reason = reason;
    captchaFlowState.captchaId = null;
    captchaFlowState.img = "";
    captchaFlowState.error = "";

    captchaFlowState.submit = async (text: string) => {
      if (!captchaFlowState.captchaId) return;
      captchaFlowState.submitting = true;
      try {
        const result = await rpc!.solve(proxyId, captchaFlowState.captchaId, text);
        if (!result.done) {
          captchaFlowState.error = "incorrect";
          captchaFlowState.submitting = false;
          await load(true);
          return;
        }
        end();
        resolve(result);
      } catch {
        captchaFlowState.error = "incorrect";
        captchaFlowState.submitting = false;
      }
    };

    captchaFlowState.refresh = () => load(true);

    captchaFlowState.cancel = () => {
      end();
      reject("close");
    };

    load(false);
  });
}
```

**Step 3: Verify**

Run: `npx vitest run src/entities/auth/lib/__tests__/captcha-flow-bridge.test.ts` → PASS.

### Task B2: Wire `platform.ui.captcha` for real

**Files:**
- Modify: `src/app/providers/chat-scripts/config/pocketnetinstance.ts:97-105`
- Modify: `src/app/providers/initializers/app-initializer.ts` (constructor, near where other one-time wiring happens)

**Step 1:** Replace the reject-stub:

```typescript
// pocketnetinstance.ts
import { beginCaptchaFlow } from "@/entities/auth/lib/captcha-flow-bridge";

// ...
    // Bastyon Actions SDK calls platform.ui.* on interactive recovery paths.
    // ui.captcha is real (see captcha-flow-bridge.ts, Track B of the
    // 2026-08-29 registration plan) — it populates captchaFlowState, which
    // the EXISTING CaptchaStep.vue wizard step (unchanged template) reads
    // from. No new UI is rendered by this call.
    // ui.support/ui.edituserinfo stay stubbed — chat has no such UI and no
    // code path needs them.
    ui: {
      captcha: (reason: string, _registerComponent: (c: unknown) => void, proxyOptions: { proxy: string }) =>
        beginCaptchaFlow(reason, proxyOptions),
      support: () => Promise.reject(new Error("support_ui_unavailable")),
      edituserinfo: () => Promise.reject(new Error("edituserinfo_ui_unavailable")),
    },
```

**Step 2:** Wire the RPC implementation once, in `AppInitializer`'s constructor (`app-initializer.ts`, right after `this._available = true;` at line 157):

```typescript
    this._available = true;
    configureCaptchaRpc({
      fetch: (proxyId, currentCaptchaId) => this.getCaptcha(proxyId, currentCaptchaId),
      solve: (proxyId, captchaId, text) => this.solveCaptcha(proxyId, captchaId, text),
    });
```

(`configureCaptchaRpc` imported from `@/entities/auth/lib/captcha-flow-bridge`.) `getCaptcha`/`solveCaptcha` (`app-initializer.ts:257-295`) are reused completely unchanged — they already have the correct RPC shape (confirmed against the vendor's own `self.sdk.captcha.get`/`.make`).

**Step 3: Add a way to actually call `requestUnspents()`**

The vendor method that triggers all of this (`Account.requestUnspents`) is only reachable through a live `Account` instance. Expose it, still with the exact same `getCaptcha`/`solveCaptcha`-style RPC shape everything else in `app-initializer.ts` uses:

```typescript
  /** Calls the vendor SDK's own Account.requestUnspents({reason:'registration'})
   *  directly — the exact method the automatic actions_noinputs recovery
   *  path would eventually call, invoked explicitly and immediately instead
   *  of waiting for a failed send attempt. Internally: picks a proxy
   *  (parent.api.get.proxywithwalletls()), calls solveCaptcha() → our
   *  platform.ui.captcha (captchaFlowState), then grants PKOIN via
   *  free/balance once solved. Resolves once PKOIN has actually landed. */
  async requestRegistrationFunding(address: string): Promise<void> {
    if (!this.actions) throw new Error("Actions not available");
    const account = this.actions.addAccount(address) as unknown as {
      requestUnspents: (params: { reason: string }) => Promise<unknown>;
    };
    await withTimeout(
      account.requestUnspents({ reason: "registration" }),
      REGISTRATION_RPC_TIMEOUT,
      "requestRegistrationFunding",
    );
  }
```

**Step 4: Test**

Create `src/app/providers/chat-scripts/config/__tests__/pocketnetinstance-captcha.test.ts` asserting `PocketnetInstance.platform.ui.captcha` is not the old rejecting stub (source-level check, matching this repo's existing pattern for these config-object tests) — mirrors Task 3's `registration-poll-trust-sdk.test.ts` style.

### Task B3: Rewire `CaptchaStep.vue`'s script only — template stays untouched

**Files:**
- Modify: `src/features/auth/ui/register-form/steps/CaptchaStep.vue` — **`<script setup>` block only, zero changes to `<template>`**
- Modify: `src/entities/auth/model/stores.ts` (new store action, `register()` simplification)

**Step 1: New store action**, alongside the existing `fetchCaptcha`/`submitCaptcha` (`stores.ts:1567-1595`) — added, not replacing them yet (see Task B6 for eventual removal):

```typescript
  /** Track B: same end result as fetchCaptcha+submitCaptcha+requestFreeRegistration
   *  combined, but driven by the vendor SDK's own Account.requestUnspents()
   *  instead of three manual RPC calls. Resolves once PKOIN has actually
   *  been granted — captcha AND funding both done by the time this returns,
   *  unlike the old flow where funding was deferred to register(). */
  const requestRegistrationFunding = async () => {
    if (!regAddress.value) throw new Error("No registration address");
    await appInitializer.requestRegistrationFunding(regAddress.value);
  };
```

**Step 2: `CaptchaStep.vue` — script diff only.** Template block (lines 58-105 in the current file) is not shown here because **nothing in it changes** — same `v-html="captchaSvg"`, same input/button classes, same `Spinner`, same i18n keys:

```typescript
<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useI18n } from "@/shared/lib/i18n";
import { captchaFlowState } from "@/entities/auth/lib/captcha-flow-bridge";

const emit = defineEmits<{ done: [] }>();
const { t } = useI18n();
const authStore = useAuthStore();

const sanitizeSvg = (svg: string): string => {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/on\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "");
};

// These four refs keep the exact same names the template already binds to
// (captchaSvg, captchaText, loading, error) — only their source changes,
// from authStore.fetchCaptcha/submitCaptcha to captchaFlowState (populated
// by the real platform.ui.captcha, see captcha-flow-bridge.ts).
const captchaSvg = computed(() => sanitizeSvg(captchaFlowState.img));
const captchaText = ref("");
const loading = computed(() => captchaFlowState.active && !captchaFlowState.img);
const submitting = computed(() => captchaFlowState.submitting);
const error = computed(() => {
  if (captchaFlowState.error === "load_failed") return t("register.captchaLoadFailed");
  if (captchaFlowState.error === "incorrect") return t("register.captchaIncorrect");
  return "";
});

const handleSubmit = async () => {
  if (!captchaText.value.trim()) return;
  await captchaFlowState.submit(captchaText.value.trim());
  captchaText.value = "";
};

const loadCaptcha = () => captchaFlowState.refresh();

onMounted(async () => {
  try {
    // Kicks off Account.requestUnspents() → solveCaptcha() →
    // platform.ui.captcha() → beginCaptchaFlow(), which populates
    // captchaFlowState above. Resolves once PKOIN is actually granted —
    // that's the real "captcha step done" signal, stronger than the old
    // flow's "captcha text accepted" (which didn't guarantee funding yet).
    await authStore.requestRegistrationFunding();
    emit("done");
  } catch (e) {
    if (e === "close") return; // user cancelled — stays on this step, see Task B4
    // network/state/noproxy — surface via the same error ref the template
    // already renders; user can retry via the existing "refresh" button.
  }
});
</script>
```

**No changes anywhere to:** `RegisterForm.vue` (still 3 steps, still `currentStep === 2` renders `CaptchaStep`), `RegistrationStepper.vue`, any CSS, any i18n key, the wizard's progress bar, or step ordering. The user sees the identical screen at the identical point in the identical flow — the only thing that changed is that solving the captcha now also grants PKOIN in the same round-trip (previously that was a separate `requestFreeRegistration` call deferred until the final register step). That is a **behavior improvement worth calling out explicitly**, not a style change: funding completes earlier and more visibly (the step's spinner/error states already cover it) instead of failing silently later inside `register()`'s poll.

**Step 3: Simplify `register()`** now that funding already happened in step 2 — drop the now-redundant `requestFreeRegistration` call, keep everything else:

```typescript
  const register = async (profile: { name: string; language: string; about: string; image?: string }) => {
    if (!regAddress.value || !regMnemonic.value) {
      throw new Error("Registration state incomplete");
    }

    // PKOIN was already granted in CaptchaStep.vue's onMounted (Track B) —
    // no separate requestFreeRegistration call needed here anymore.
    const encKeys = generateEncryptionKeys(regPrivateKeyHex.value!);
    const encPublicKeys = encKeys.map(k => k.public);
    setPendingRegProfile({ ...profile, encPublicKeys });

    const mnemonic = regMnemonic.value;
    clearRegistrationState();

    try {
      establishAuthSession(mnemonic);
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Login failed after registration');
    }

    setRegistrationPending(true);
    setRegistrationPhase('init');
    startRegistrationPoll();

    completeLoginNetwork().catch((e) => {
      console.warn("[auth] completeLoginNetwork failed during registration auto-login (non-fatal, poll continues):", e);
    });
  };
```

The poll's Phase 1 `checkUnspents` pre-check (`stores.ts:1786-1817`) stays exactly as-is — it's still the correct behavior (funding should already be present by the time the poll reaches it; if it somehow isn't — e.g. a race, or a resumed session — the existing `checkUnspents`-then-`registerUserProfile` sequence still works unmodified, and a forced broadcast on unfunded unspents would now also correctly trigger `platform.ui.captcha` again as a fallback, since it's real).

**Step 4: Tests**

Add a test asserting `CaptchaStep.vue`'s `onMounted` calls `authStore.requestRegistrationFunding()` (not the old `fetchCaptcha`) and emits `done` only after it resolves. Add a test asserting `register()` no longer calls `appInitializer.requestFreeRegistration`. Existing `CaptchaStep.vue` rendering/snapshot tests (if any) should need **zero changes** — that's the point; if one needs a change, something broke the "template untouched" constraint above.

### Task B4: Handle the no-auto-retry-after-cancel latch (open risk, must resolve before shipping)

**This is the one confirmed rough edge — do not skip it.** Per `actions.js:1639-1649`, a rejected `requestUnspents` (any reason, including the user cancelling — `'close'`, e.g. navigating back from `CaptchaStep`) sets `self.checkRequestUnspentsInAnotherSession = true` on the `Account` instance and `action.checkInAnotherSession = true` on the action. Both are **latches**: a later `actions_noinputs` (e.g. from the registration poll's own forced-broadcast fallback) will see `if(self.checkRequestUnspentsInAnotherSession) return Promise.reject(error)` and skip `userInteractive` entirely — i.e. **the SDK will not auto-trigger `platform.ui.captcha` again for that `Account` instance in that page session**.

This matters less than it would have in the original (auto-triggered) design, because in this corrected design `CaptchaStep.vue`'s `onMounted` calls `requestRegistrationFunding()` **explicitly**, not through the latched `actionRejected` path — so the normal "user reopens/retries the step" case (e.g. `loadCaptcha`'s existing refresh button, or simply re-mounting `CaptchaStep` by navigating back to it) already bypasses the latch fine, since it's a fresh direct call each time, not a re-triggered auto-recovery. The latch only bites the *fallback* path in Task B3 Step 3 (poll discovers still-unfunded unspents and force-broadcasts into `actions_noinputs` again) — which should be rare given funding already happened at step 2, but is worth covering:

1. If the poll's fallback broadcast hits the latch, it throws same as any other broadcast failure — already handled by the existing retry/backoff/timeout path (Track A or the current code, either way), no captcha modal reappears because none should be needed at that point.
2. Add a regression test confirming `CaptchaStep.vue` itself never hits the latch (it always calls `requestRegistrationFunding()` fresh, not through `actionRejected`) — this is the property that makes B4 low-risk here versus in the originally-drafted auto-trigger design.
3. If a future need arises for an explicit "funding failed, retry" affordance beyond `CaptchaStep`'s own error/refresh UI (already covered by Step 2's `error`/`loadCaptcha` in the unchanged template), it can call `requestRegistrationFunding()` again directly — same bypass property.

### Task B5: Manual + automated verification

Manual scenarios on dev (`setTrustSdkEngine` from Track A can be on or off independently — Track B is orthogonal):
1. Fresh registration, solve captcha correctly first try → confirm `CaptchaStep` looks pixel-identical to before this change, and that PKOIN is granted by the time it emits `done` (check via telemetry/logs, not just UI).
2. Submit a wrong captcha text → confirm the existing "incorrect" error + auto-refresh behavior in `CaptchaStep.vue` still works, now sourced from `captchaFlowState` instead of `authStore.submitCaptcha`.
3. Click "refresh captcha" mid-flow → confirm it still works (now calls `captchaFlowState.refresh()`).
4. Navigate back from `CaptchaStep` (cancelling the in-flight `requestUnspents`) and forward again → confirm a fresh captcha loads cleanly (verifies the Task B4 bypass property).
5. Registration with the app backgrounded right as captcha would load (Android) — confirm no regression versus current behavior (this step was already reactive-state-driven before this track, so should be unaffected).
6. Side-by-side screenshot diff of `CaptchaStep.vue` before/after this track's script change — should be **identical**; if not, something in the constraint at the top of Track B was violated.

Full verification per CLAUDE.md (`npm run build`, `npx vue-tsc --noEmit`, `npm run test`, `/code-review high`) before merge — same bar as Track A, this touches the registration flow directly even though it touches no visible pixels.

### Task B6: Cleanup (only after B1-B5 have run stable on production for a full release cycle)

Remove the now-unused `fetchCaptcha`/`submitCaptcha`/`findRegistrationProxy`/`regProxyId`/`regCaptchaId`/`regCaptchaDone` (`stores.ts:222-224, 1553-1595`) and `appInitializer.getCaptcha`/`solveCaptcha`'s now-sole-remaining-caller status (they're still used indirectly via `configureCaptchaRpc` in Task B2 — do NOT remove those two methods, only the direct manual-orchestration call sites in `stores.ts`). Check `ProxyRotator`/`getRegistrationProxy` usage elsewhere in the codebase before deleting — may be used by non-registration flows. `CaptchaStep.vue` itself is **never removed** — it's the permanent home of the captcha UI in both the old and new design.

## Summary of what changes vs. what doesn't

| Piece | Outcome |
|---|---|
| Force-broadcast on every poll tick | **Removed** — forced once per loop, SDK interval owns the rest |
| `undefined_status` inline guess | **Extracted + documented**, same behavior |
| Backoff ceiling (60s) | **Lowered to 8s** in trust-SDK mode (cheap status-only reads) |
| `pendingUserInfoActions` collision guard | **Unchanged** — still required, now covered by an explicit regression test (Task 2) |
| `registrationPollGeneration` / `pollInFlight` | **Unchanged** in this plan — still guards against our own multiple retry entry points, independent of how often we force-broadcast |
| `PollTimer`, 30-min timeout, 10-min cancel | **Unchanged** — no SDK equivalent exists |
| `verifyAndRepublishKeys`, `likelyBastyonUser` | **Unchanged** — out of scope, Forta-specific |
| `blockchain-ws` | **Investigated only** (Task 6) — no change without a separate follow-up plan |
| `platform.ui.captcha` stub | **Replaced** (Track B) with a real, headless implementation (`captcha-flow-bridge.ts`) — `requestUnspents → solveCaptcha → platform.ui.captcha` now works end-to-end instead of always rejecting. No new visible UI. |
| `CaptchaStep.vue` template, `RegisterForm.vue` step count/order, wizard visuals | **Unchanged, verified twice** — Track B only swaps the data source inside `CaptchaStep.vue`'s existing `<script setup>`; zero template/CSS/step-count changes |
| Manual proxy/captcha/`free/balance` call sites (`findRegistrationProxy`, `fetchCaptcha`, `submitCaptcha`, `requestFreeRegistration` in `stores.ts`) | **Removed** (Track B, after B1-B5 prove stable) — same RPCs, now called by the SDK's own `Account.requestUnspents()` instead of duplicated manually; `CaptchaStep.vue` itself stays |
| When PKOIN funding happens | **Shifts earlier** (Track B) — from "deferred until `register()`'s final step" to "as soon as captcha is solved, step 2" — a behavior improvement (funding failures surface where the user can see/retry them), not a visual change |

## Sequencing between the two tracks

Track A and Track B touch the same `poll()`/`registerUserProfile` call path but change different things (retry cadence vs. who triggers funding) — they can be developed in either order, but **ship and roll out Track A first**. Reasons:
- Track A is purely internal (no UI change), flag-gated, and easy to roll back.
- Track B changes nothing visible, but it does change *when* PKOIN funding happens (earlier, at step 2 instead of deferred to `register()`) and swaps three trusted manual RPC calls for reliance on vendor `Account.requestUnspents()` internals we don't control — that needs its own soak time independent of Track A's changes.
- Debugging is much easier with only one variable changing in production at a time — if Track A's telemetry (Task 1) is already running, Track B can reuse the same `reg-telemetry` log tag rather than inventing a second observability mechanism.
