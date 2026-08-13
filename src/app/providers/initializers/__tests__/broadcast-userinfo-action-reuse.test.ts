import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = () =>
  readFileSync(resolve(__dirname, "../app-initializer.ts"), "utf-8");

/**
 * The Actions SDK manages a queued action's own retries (a 3s internal
 * interval started by Actions.init()) — calling `addActionAndSendIfCan`
 * again for the same account while a previous UserInfo action is still
 * outstanding queues a SECOND action instead of advancing the first. The
 * SDK's own collision guard only supersedes an older UserInfo action while
 * it hasn't been sent yet; once sent, both coexist and the SDK rejects one
 * of them the next time it processes the queue ("actions_collision").
 *
 * Every registration poll retry (attempt 1, 2, 3, ...) that reaches the
 * broadcast branch previously called broadcastUserInfoAction with a brand
 * new UserInfo object and no memory of a prior attempt — so failures piled
 * up queued actions instead of ever just re-checking the one already in
 * flight.
 */
describe("broadcastUserInfoAction reuses a queued action across retries", () => {
  it("keeps a pendingUserInfoActions map keyed by address", () => {
    const src = getSource();
    expect(src).toContain("private pendingUserInfoActions = new Map<string, BroadcastableAction>();");
  });

  it("checks for an existing queued action before calling addActionAndSendIfCan again", () => {
    const src = getSource();
    const start = src.indexOf("private async broadcastUserInfoAction(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 2200);

    const existingCheckIdx = body.indexOf("this.pendingUserInfoActions.get(address)");
    const requeueIdx = body.indexOf("this.actions!.addActionAndSendIfCan(");
    expect(existingCheckIdx).toBeGreaterThan(-1);
    expect(requeueIdx).toBeGreaterThan(existingCheckIdx);
  });

  it("does not drop the pending action on a non-terminal failure (only on a terminal rejection)", () => {
    const src = getSource();
    const start = src.indexOf("private async broadcastUserInfoAction(");
    const body = src.slice(start, start + 2200);
    // Both branches (reuse path and fresh-queue path) must only delete the
    // map entry when the action itself is rejected — a transient/timeout
    // failure must leave the entry in place so the next retry reuses it
    // instead of requeuing.
    const deleteMatches = body.match(/this\.pendingUserInfoActions\.delete\(address\);/g) ?? [];
    expect(deleteMatches.length).toBeGreaterThanOrEqual(3); // success (x2) + terminal-rejected (x2, one guarded by `if (!existing.rejected) throw`)
    expect(body).toMatch(/if \(!existing\.rejected\) \{[\s\S]*?throw e;/);
    expect(body).toMatch(/if \(!queued\.rejected\) throw e;/);
  });

  it("stores the freshly queued action back into the map so the next retry can find it", () => {
    const src = getSource();
    const start = src.indexOf("private async broadcastUserInfoAction(");
    const body = src.slice(start, start + 2200);
    const queueIdx = body.indexOf("this.actions!.addActionAndSendIfCan(");
    const storeIdx = body.indexOf("this.pendingUserInfoActions.set(address, queued);");
    expect(storeIdx).toBeGreaterThan(queueIdx);
  });

  it("exposes clearPendingUserInfoAction for the cancel-registration path", () => {
    const src = getSource();
    expect(src).toContain("clearPendingUserInfoAction(address: string): void {");
    expect(src).toContain("this.pendingUserInfoActions.delete(address);");

    const storesSrc = readFileSync(
      resolve(__dirname, "../../../../entities/auth/model/stores.ts"),
      "utf-8",
    );
    const cancelStart = storesSrc.indexOf("const cancelRegistration = async () =>");
    expect(cancelStart).toBeGreaterThan(-1);
    const cancelBody = storesSrc.slice(cancelStart, cancelStart + 700);
    expect(cancelBody).toContain("appInitializer.clearPendingUserInfoAction(address.value);");
  });

  // Code-review follow-up: the reuse branch keeps re-driving a non-terminal
  // pending action, so a caller that changes broadcast content for the same
  // address (new username after a code-18 rejection) must not rely on the
  // SDK having already marked the old action `.rejected` — that's incidental,
  // not guaranteed for every failure mode. Clear explicitly instead.
  it("retryRegistrationWithNewName clears the pending action before restarting the poll", () => {
    const storesSrc = readFileSync(
      resolve(__dirname, "../../../../entities/auth/model/stores.ts"),
      "utf-8",
    );
    const start = storesSrc.indexOf("const retryRegistrationWithNewName = async");
    expect(start).toBeGreaterThan(-1);
    const end = storesSrc.indexOf("const setRegistrationPending", start);
    const body = storesSrc.slice(start, end > start ? end : start + 1200);
    const clearIdx = body.indexOf("appInitializer.clearPendingUserInfoAction(address.value)");
    const startPollIdx = body.indexOf("startRegistrationPoll()");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(startPollIdx).toBeGreaterThan(clearIdx);
  });

  // AppInitializer/pendingUserInfoActions is a session-lifetime singleton
  // (created once in createAppInitializer()) — logout must not leave a stale
  // non-terminal action behind for an address that might register again in
  // the same app session.
  it("logout() also clears the pending UserInfo action for the logging-out address", () => {
    const storesSrc = readFileSync(
      resolve(__dirname, "../../../../entities/auth/model/stores.ts"),
      "utf-8",
    );
    const start = storesSrc.indexOf("const logout = async () =>");
    expect(start).toBeGreaterThan(-1);
    const body = storesSrc.slice(start, start + 3200);
    expect(body).toContain("appInitializer.clearPendingUserInfoAction(logoutAddress)");
  });
});
