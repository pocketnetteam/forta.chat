import { describe, it, expect } from "vitest";
import {
  readUserInfoActionState,
  userInfoStateKey,
  isRegistrationConfirmedStatus,
} from "../vendor-actions";

describe("readUserInfoActionState", () => {
  it("reports a freshly queued action as queued, not sending", () => {
    expect(readUserInfoActionState({ id: "a1" })).toEqual({ kind: "queued", sending: false });
  });

  it("reports an in-flight sendrawtransaction as queued + sending", () => {
    expect(readUserInfoActionState({ id: "a1", sending: new Date() })).toEqual({
      kind: "queued",
      sending: true,
    });
  });

  it("reports an action with a txid as sent", () => {
    expect(readUserInfoActionState({ id: "a1", transaction: "tx1" })).toEqual({ kind: "sent", txid: "tx1" });
  });

  it("completed wins over everything else", () => {
    expect(
      readUserInfoActionState({ id: "a1", transaction: "tx1", completed: true, rejected: 18 }),
    ).toEqual({ kind: "completed", txid: "tx1" });
  });

  it("rejected wins over transaction (vendor Action.processing precedence)", () => {
    // e.g. marked rejected while its sendrawtransaction was still in flight
    expect(
      readUserInfoActionState({ id: "a1", transaction: "tx1", rejected: "actions_alreadySending" }),
    ).toEqual({ kind: "rejected", reason: "actions_alreadySending" });
  });

  it("keeps the code-18 rejection reason so the username-taken UI can fire", () => {
    expect(readUserInfoActionState({ id: "a1", rejected: 18 })).toEqual({ kind: "rejected", reason: 18 });
  });

  it("treats a vendor 'wait' rejection (rejectWait set) as a pending retry, not a failure", () => {
    expect(
      readUserInfoActionState({ id: "a1", rejected: 261, rejectWait: new Date(Date.now() + 60_000) }),
    ).toEqual({ kind: "waiting-retry" });
  });
});

describe("userInfoStateKey", () => {
  it("is equal for repeated emissions of the same state and differs across transitions", () => {
    const queued = userInfoStateKey({ kind: "queued", sending: false });
    expect(userInfoStateKey({ kind: "queued", sending: false })).toBe(queued);
    expect(userInfoStateKey({ kind: "queued", sending: true })).not.toBe(queued);
    expect(userInfoStateKey({ kind: "sent", txid: "tx1" })).not.toBe(
      userInfoStateKey({ kind: "sent", txid: "tx2" }),
    );
  });
});

describe("isRegistrationConfirmedStatus", () => {
  it("accepts 'registered' and the vendor's 'undefined_status' race", () => {
    expect(isRegistrationConfirmedStatus("registered")).toBe(true);
    expect(isRegistrationConfirmedStatus("undefined_status")).toBe(true);
  });

  it("rejects every in-progress / unavailable status", () => {
    for (const s of [
      "in_progress_transaction",
      "in_progress_hasUnspents",
      "in_progress_wait_unspents",
      "not_in_progress",
      "not_in_progress_no_processing",
      "not_available",
    ]) {
      expect(isRegistrationConfirmedStatus(s)).toBe(false);
    }
  });
});
