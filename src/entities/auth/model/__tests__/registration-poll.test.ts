import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = () => readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");

describe("registration poll", () => {
  it("should not have a hardcoded 5-minute timeout", () => {
    const source = getSource();
    expect(source).not.toContain("MAX_WAIT_MS");
    expect(source).not.toContain("5 * 60 * 1000");
  });

  it("should use setTimeout instead of setInterval for backoff", () => {
    const source = getSource();
    // Poll scheduling must use setTimeout; setInterval is only for the elapsed UI ticker.
    const pollSection = source.slice(
      source.indexOf("const startRegistrationPoll"),
      source.indexOf("const stopRegistrationPoll")
    );
    expect(pollSection).toContain("setTimeout(poll");
    const scheduleSection = pollSection.slice(
      pollSection.indexOf("const schedulePoll"),
      pollSection.indexOf("const schedulePoll") + 250,
    );
    expect(scheduleSection).toContain("setTimeout");
    expect(scheduleSection).not.toContain("setInterval");
  });

  it("should use exponential backoff with 60s cap", () => {
    const source = getSource();
    const pollSection = source.slice(
      source.indexOf("const startRegistrationPoll"),
      source.indexOf("const stopRegistrationPoll")
    );
    expect(pollSection).toContain("Math.min");
    expect(pollSection).toContain("60000");
  });

  it("broadcast path wraps sync/init in withTimeout and keeps pending profile until send succeeds", () => {
    const source = getSource();
    const pollSection = source.slice(
      source.indexOf("const startRegistrationPoll"),
      source.indexOf("const stopRegistrationPoll"),
    );
    expect(pollSection).toContain('"syncNodeTime"');
    expect(pollSection).toContain('"initializeAndFetchUserData"');
    expect(pollSection).toContain("registerUserProfile");
    // pendingRegProfile cleared only after successful registerUserProfile
    const broadcastIdx = pollSection.indexOf("registerUserProfile");
    const clearIdx = pollSection.indexOf("setPendingRegProfile(null)", broadcastIdx);
    expect(clearIdx).toBeGreaterThan(broadcastIdx);
  });

  it("treats Actions undefined_status as registration confirmed", () => {
    const source = getSource();
    const pollSection = source.slice(
      source.indexOf("const startRegistrationPoll"),
      source.indexOf("const stopRegistrationPoll"),
    );
    expect(pollSection).toMatch(
      /actionsStatus === ['"]registered['"]\s*\|\|\s*actionsStatus === ['"]undefined_status['"]/,
    );
  });

  it("should use clearTimeout in stopRegistrationPoll", () => {
    const source = getSource();
    const stopSection = source.slice(
      source.indexOf("const stopRegistrationPoll"),
      source.indexOf("const stopRegistrationPoll") + 500
    );
    expect(stopSection).toContain("clearTimeout");
  });

  it("should call loadUsersInfo with update:true before initializeAndFetchUserData on registration confirmed", () => {
    const source = getSource();
    const fnStart = source.indexOf("async function onRegistrationConfirmed");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSection = source.slice(fnStart, fnStart + 2800);
    // Address may be passed either as `address.value!` directly or as a
    // snapshot variable (`confirmedAddress`) — both are valid; the only
    // ordering invariant is that loadUsersInfo runs before initializeAndFetchUserData.
    const loadMatch = fnSection.match(
      /loadUsersInfo\(\s*\[\s*(?:address\.value!|confirmedAddress)\s*\]\s*,\s*\{\s*update:\s*true\s*\}\s*\)/,
    );
    const loadIdx = loadMatch?.index ?? -1;
    const initIdx = fnSection.indexOf("initializeAndFetchUserData");
    expect(loadIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(loadIdx);
    // Full-profile reload must also bypass local cache.
    expect(fnSection).toContain("{ update: true }");
  });

  it("onRegistrationConfirmed kicks room-list sync when Matrix is already ready", () => {
    const source = getSource();
    const fnStart = source.indexOf("async function onRegistrationConfirmed");
    expect(fnStart).toBeGreaterThan(-1);
    // Window widened (WEE-XX): loadUsersInfo/initializeAndFetchUserData here
    // are now wrapped in withTimeout (same unguarded-hang class as fetchUserInfo),
    // pushing the isRoomListLoading/retryImmediately/refreshRoomsNow block further in.
    const fnSection = source.slice(fnStart, fnStart + 5200);
    // When matrixReady is already true, heal the empty-list skeleton instead of
    // skipping sync entirely (post-registration hang until refresh).
    expect(fnSection).toContain("isRoomListLoading");
    expect(fnSection).toContain("retryImmediately");
    expect(fnSection).toContain("refreshRoomsNow");
  });
});

describe("registration poll pins checkUnspents to the last WS transaction node", () => {
  // blockchain-ws "transaction" events carry a `node` field — the node that
  // already indexed the incoming tx. checkUnspents pins its first attempt to
  // it (with an automatic failover fallback) to work around node-to-node
  // replication lag right after the WS event fires.
  it("onTransaction captures the event's node into _lastTxNodeHint", () => {
    const source = getSource();
    const start = source.indexOf("onTransaction: ({ node }) =>");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 200);
    expect(body).toContain("if (node) _lastTxNodeHint = node;");
  });

  it("phase 1's checkUnspents call passes _lastTxNodeHint", () => {
    const source = getSource();
    const pollSection = source.slice(
      source.indexOf("const poll = async () =>"),
      source.indexOf("const schedulePoll ="),
    );
    expect(pollSection).toContain("appInitializer.checkUnspents(address.value, _lastTxNodeHint)");
  });
});

describe("registration poll cannot run two concurrent loops", () => {
  // Bug: startRegistrationPoll() is called from 4 places (register(),
  // retryRegistrationWithNewName(), retryRegistration(), resumeRegistrationPoll()
  // on app reload). The old reentrancy guard checked `registrationPollTimer`,
  // which is only assigned once the FIRST poll() tick finishes (inside
  // schedulePoll) — so a second start during that window slipped past the
  // guard and spun up a second, independent poll loop. Both loops then
  // broadcast the same UserInfo action for the same address concurrently, and
  // the Actions SDK's collision guard rejected one of them
  // ("actions_collision" / "UserInfo broadcast did not produce a transaction").
  it("startRegistrationPoll increments a generation token that supersedes any prior loop", () => {
    const source = getSource();
    const fnStart = source.indexOf("const startRegistrationPoll = () =>");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSection = source.slice(fnStart, fnStart + 600);
    expect(fnSection).toContain("const myGeneration = ++registrationPollGeneration;");
  });

  it("poll() bails before broadcasting if a newer loop has since started", () => {
    const source = getSource();
    const pollSection = source.slice(
      source.indexOf("const poll = async () =>"),
      source.indexOf("const schedulePoll ="),
    );
    // Checked once at the top of every tick...
    expect(pollSection).toMatch(/if \(myGeneration !== registrationPollGeneration\) return;/);
    // ...and again right before the actual broadcast, since the awaits in
    // between (syncNodeTime/initializeAndFetchUserData) can take seconds.
    const checks = pollSection.match(/myGeneration !== registrationPollGeneration/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(2);
    const secondCheckIdx = pollSection.indexOf(
      "myGeneration !== registrationPollGeneration",
      pollSection.indexOf("myGeneration !== registrationPollGeneration") + 1,
    );
    const broadcastIdx = pollSection.indexOf("appInitializer.registerUserProfile");
    expect(secondCheckIdx).toBeGreaterThan(-1);
    expect(broadcastIdx).toBeGreaterThan(secondCheckIdx);
  });

  it("poll() also re-checks the generation right before every onRegistrationConfirmed() call", () => {
    // A stale loop finishing its RPC await and calling onRegistrationConfirmed()
    // just after a newer loop already took over would run the whole
    // completion flow (profile reload, initMatrix, 1.5s success screen) twice.
    const source = getSource();
    const pollSection = source.slice(
      source.indexOf("const poll = async () =>"),
      source.indexOf("const schedulePoll ="),
    );
    const confirmCallPositions: number[] = [];
    let idx = pollSection.indexOf("await onRegistrationConfirmed()");
    while (idx !== -1) {
      confirmCallPositions.push(idx);
      idx = pollSection.indexOf("await onRegistrationConfirmed()", idx + 1);
    }
    // Phase 1 early-complete, Actions-confirmed, and blockchain-confirmed paths.
    expect(confirmCallPositions.length).toBe(3);
    for (const callPos of confirmCallPositions) {
      const precedingSection = pollSection.slice(Math.max(0, callPos - 400), callPos);
      expect(precedingSection).toContain("myGeneration !== registrationPollGeneration");
    }
  });

  it("stopRegistrationPoll invalidates the current generation too", () => {
    const source = getSource();
    const fnStart = source.indexOf("const stopRegistrationPoll = () =>");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSection = source.slice(fnStart, fnStart + 300);
    expect(fnSection).toContain("registrationPollGeneration++;");
  });

  // Second, narrower race within a SINGLE loop: _registrationPollKick (fired
  // by blockchain-ws on inbound block/tx events) calls poll() directly and
  // only guards on `registrationPollTimer`, which is null while a tick is
  // already mid-flight — so a kick arriving during a tick could start a
  // second concurrent tick of the same loop and double-broadcast.
  it("poll() guards against _registrationPollKick re-entering while a tick is mid-flight", () => {
    const source = getSource();
    const pollSection = source.slice(
      source.indexOf("const poll = async () =>"),
      source.indexOf("const schedulePoll ="),
    );
    expect(pollSection).toContain("if (pollInFlight) return;");
    expect(pollSection).toContain("pollInFlight = true;");
    expect(pollSection).toMatch(/finally\s*\{\s*pollInFlight = false;/);
  });
});

describe("login key verification", () => {
  it("should have verifyAndRepublishKeys function", () => {
    const source = getSource();
    expect(source).toContain("verifyAndRepublishKeys");
  });

  it("completeLoginNetwork should call verifyAndRepublishKeys between fetchUserInfo and initMatrix", () => {
    // login()'s network half was extracted into completeLoginNetwork() (WEE-XX)
    // so register() can start the bounded registration poll right after the
    // sync half (establishAuthSession) instead of after this whole chain —
    // the call-order invariant now lives here rather than inline in `login`.
    const source = getSource();
    const loginSection = source.slice(
      source.indexOf("const completeLoginNetwork"),
      source.indexOf("const completeLoginNetwork") + 800
    );
    const fetchPos = loginSection.indexOf("fetchUserInfo");
    const verifyPos = loginSection.indexOf("verifyAndRepublishKeys");
    const matrixPos = loginSection.indexOf("initMatrix");
    expect(fetchPos).toBeGreaterThan(-1);
    expect(verifyPos).toBeGreaterThan(fetchPos);
    expect(matrixPos).toBeGreaterThan(verifyPos);
  });

  it("verifyAndRepublishKeys should check keys via both cache and RPC", () => {
    const source = getSource();
    const fnStart = source.indexOf("const verifyAndRepublishKeys");
    const fnSection = source.slice(fnStart, fnStart + 2000);
    // Should check the local cache first (fast path)
    expect(fnSection).toContain("countCachedKeys");
    expect(fnSection).toContain("REQUIRED_ENCRYPTION_KEYS");
    // Fresh profile via SDK (loadUsersInfoRaw wraps loadUsersInfo + getRawProfile)
    expect(fnSection).toContain("loadUsersInfoRaw");
    expect(fnSection).toContain("countPublishedKeys");
  });

  it("verifyAndRepublishKeys should not block login if RPC fails", () => {
    const source = getSource();
    const fnStart = source.indexOf("const verifyAndRepublishKeys");
    const fnSection = source.slice(fnStart, fnStart + 2600);
    expect(fnSection).toContain("RPC key check failed");
  });
});

describe("pcrypto getUsersInfo profile load", () => {
  it("should use a single loadUsersInfo batch and getUserData, not parallel loadUsersInfoRaw", () => {
    const source = getSource();
    const idx = source.indexOf("getUsersInfo: async");
    expect(idx).toBeGreaterThan(-1);
    const section = source.slice(idx, idx + 4500);
    expect(section).toContain("loadUsersInfo(rawAddresses, { update: options?.forceUpdate ?? false })");
    expect(section).toContain("getUserData");
    expect(section).not.toContain("loadUsersInfoRaw");
  });
});

describe("register() starts the poll before the network login half", () => {
  // WEE-XX: register() previously awaited the full login() chain (fetchUserInfo
  // + verifyAndRepublishKeys + initMatrix — none of it bounded by a top-level
  // timeout) before ever calling startRegistrationPoll(), whose 30-min
  // PollTimer + per-RPC withTimeout is the only safety net on this screen. A
  // dead/blocked proxy inside that chain (observed: fetchUserInfo 408s) hung
  // "Подготовка аккаунта" with no bound at all. Fix: split login into a sync
  // half (establishAuthSession) and a network half (completeLoginNetwork),
  // and start the poll between them.
  it("register() calls establishAuthSession, then startRegistrationPoll, then completeLoginNetwork", () => {
    const source = getSource();
    const fnStart = source.indexOf("const register = async (profile:");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("const retryRegistrationWithNewName", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnSection = source.slice(fnStart, fnEnd);

    const establishPos = fnSection.indexOf("establishAuthSession(mnemonic)");
    const pollPos = fnSection.indexOf("startRegistrationPoll()");
    const networkPos = fnSection.indexOf("completeLoginNetwork()");

    expect(establishPos).toBeGreaterThan(-1);
    expect(pollPos).toBeGreaterThan(establishPos);
    expect(networkPos).toBeGreaterThan(pollPos);
  });

  it("register() does not await completeLoginNetwork before returning", () => {
    const source = getSource();
    const fnStart = source.indexOf("const register = async (profile:");
    const fnEnd = source.indexOf("const retryRegistrationWithNewName", fnStart);
    const fnSection = source.slice(fnStart, fnEnd);
    // Must be fire-and-forget (with a .catch guard), not `await completeLoginNetwork()` —
    // otherwise the poll's early start buys nothing, since register() (and the
    // caller's subsequent navigation) would still block on the network chain.
    expect(fnSection).not.toMatch(/await\s+completeLoginNetwork\(\)/);
    expect(fnSection).toContain("completeLoginNetwork().catch(");
  });

  it("establishAuthSession failure never flips registrationPending", () => {
    const source = getSource();
    const fnStart = source.indexOf("const register = async (profile:");
    const fnEnd = source.indexOf("const retryRegistrationWithNewName", fnStart);
    const fnSection = source.slice(fnStart, fnEnd);
    const catchMatch = fnSection.match(/\}\s*catch\s*\(e\)\s*\{\s*throw new Error\(e instanceof Error \? e\.message : 'Login failed after registration'\);/);
    expect(catchMatch?.index).toBeGreaterThan(-1);
    const establishPos = fnSection.indexOf("establishAuthSession(mnemonic)");
    const pendingPos = fnSection.indexOf("setRegistrationPending(true)");
    // setRegistrationPending(true) must come after the establishAuthSession
    // try/catch, not before — so a bad-credential throw here can't leave a
    // stray registrationPending flag with no poll behind it.
    expect(pendingPos).toBeGreaterThan(establishPos);
    expect(pendingPos).toBeGreaterThan(catchMatch!.index!);
  });
});

describe("fetchUserInfo is resilient to transient RPC failures", () => {
  // Proxy nodes occasionally answer 408 on getuserprofile here (observed in
  // production) — must not fail the whole login()/register() chain.
  it("wraps initializeAndFetchUserData in try/catch and logs non-fatally", () => {
    const source = getSource();
    const fnStart = source.indexOf("const fetchUserInfo = async () =>");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("Verify user has 12 published encryption keys", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnSection = source.slice(fnStart, fnEnd);
    const tryPos = fnSection.indexOf("try {");
    const callPos = fnSection.indexOf("appInitializer.initializeAndFetchUserData(");
    const catchPos = fnSection.indexOf("} catch (e) {");
    expect(tryPos).toBeGreaterThan(-1);
    expect(callPos).toBeGreaterThan(tryPos);
    expect(catchPos).toBeGreaterThan(callPos);
    expect(fnSection).not.toMatch(/catch \(e\) \{\s*throw/);
  });

  // Bug: after a successful registration, the chat page's room-list skeleton
  // spun forever until a manual reload. Root cause: initializeAndFetchUserData
  // has no timeout of its own — a proxy that never responds (not just a fast
  // 408) leaves this `await` pending forever. try/catch alone doesn't help
  // because nothing ever rejects. Since register() now runs completeLoginNetwork()
  // in the background (fire-and-forget — see "does not await completeLoginNetwork"
  // above), a stuck fetchUserInfo() means initMatrix() — and therefore
  // chatStore.setHelpers()/startInitialSyncWatch() — never runs, so the
  // room-list empty-escape watchdog never arms.
  it("bounds initializeAndFetchUserData with withTimeout so a silent proxy hang cannot block initMatrix", () => {
    const source = getSource();
    const fnStart = source.indexOf("const fetchUserInfo = async () =>");
    const fnEnd = source.indexOf("Verify user has 12 published encryption keys", fnStart);
    const fnSection = source.slice(fnStart, fnEnd);
    const timeoutPos = fnSection.indexOf("withTimeout(");
    const callPos = fnSection.indexOf("appInitializer.initializeAndFetchUserData(");
    expect(timeoutPos).toBeGreaterThan(-1);
    expect(callPos).toBeGreaterThan(timeoutPos);
    expect(fnSection).toContain("RPC_CALL_TIMEOUT");
  });

  // Bug: register()'s background completeLoginNetwork() and
  // onRegistrationConfirmed() can both decide to call initMatrix() around the
  // same time (the latter re-runs it whenever matrixReady is still false when
  // the blockchain confirms). Without dedup, two concurrent calls would each
  // build a fresh MatrixKit/Pcrypto and double-wire Matrix event handlers.
  it("initMatrix is deduplicated via an in-flight promise guard", () => {
    const source = getSource();
    const guardStart = source.indexOf("let _initMatrixPromise");
    expect(guardStart).toBeGreaterThan(-1);
    const initMatrixStart = source.indexOf("const initMatrix = ", guardStart);
    const innerStart = source.indexOf("const initMatrixInner = async () =>", initMatrixStart);
    expect(initMatrixStart).toBeGreaterThan(guardStart);
    expect(innerStart).toBeGreaterThan(initMatrixStart);
    const wrapperSection = source.slice(initMatrixStart, innerStart);
    expect(wrapperSection).toContain("if (_initMatrixPromise) return _initMatrixPromise;");
    expect(wrapperSection).toContain("initMatrixInner()");
    expect(wrapperSection).toContain(".finally(");
  });

  it("bounds onRegistrationConfirmed's profile refetch with withTimeout too", () => {
    const source = getSource();
    const fnStart = source.indexOf("async function onRegistrationConfirmed");
    const fnSection = source.slice(fnStart, fnStart + 2200);
    const loadTimeoutPos = fnSection.indexOf("withTimeout(");
    const loadCallPos = fnSection.indexOf("appInitializer.loadUsersInfo(");
    const initCallPos = fnSection.indexOf("appInitializer.initializeAndFetchUserData(");
    expect(loadTimeoutPos).toBeGreaterThan(-1);
    expect(loadTimeoutPos).toBeLessThan(loadCallPos);
    expect(initCallPos).toBeGreaterThan(loadCallPos);
    // Second withTimeout wraps the initializeAndFetchUserData call
    const secondTimeoutPos = fnSection.indexOf("withTimeout(", loadCallPos);
    expect(secondTimeoutPos).toBeGreaterThan(loadCallPos);
    expect(secondTimeoutPos).toBeLessThan(initCallPos);
  });
});
