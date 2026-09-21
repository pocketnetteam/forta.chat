import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = () => readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");

const sliceFn = (src: string, startMarker: string, endMarker: string) => {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  return src.slice(start, end > start ? end : start + 3000);
};

/** Registration follows the vendor Actions SDK (public/js/lib/client/actions.js)
 *  the way Bastyon's satolist.js wires it: post-login account status, the
 *  free/balance → willChange hand-off, and status sync after confirmation. */
describe("auth store wires the Actions SDK like satolist.js", () => {
  it("fetchUserInfo runs the post-login SDK account setup outside registration", () => {
    const fn = sliceFn(getSource(), "const fetchUserInfo = async", "const verifyAndRepublishKeys");
    const guardIdx = fn.indexOf("if (!forceNetwork && address.value === requestAddress)");
    const syncIdx = fn.indexOf("appInitializer.syncActionsAccountStatus(requestAddress)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(guardIdx);
  });

  it("requestRegistrationFunding tells the SDK the granted coins are on the way", () => {
    const fn = sliceFn(getSource(), "const requestRegistrationFunding = async", "const checkUsername");
    const grantIdx = fn.indexOf("appInitializer.requestFreeRegistration(");
    const markIdx = fn.indexOf("appInitializer.markRegistrationFundingPending(fundedAddress, grant, proxyId)");
    expect(grantIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeGreaterThan(grantIdx);
  });

  it("onRegistrationConfirmed marks the SDK account registered", () => {
    const src = getSource();
    const start = src.indexOf("async function onRegistrationConfirmed");
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, start + 6000);
    expect(fn).toContain("appInitializer.syncActionsAccountStatus(");
  });

  it("the poll no longer keeps a side-channel txunspent node hint", () => {
    expect(getSource()).not.toContain("_lastTxNodeHint");
  });
});
