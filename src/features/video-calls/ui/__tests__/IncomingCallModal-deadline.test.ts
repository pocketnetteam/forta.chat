import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * One owner for the 30 s incoming deadline (calls cleanup, B2). The web modal
 * counted down on its own interval and rejected at zero while the call service
 * armed the same deadline (armIncomingTimeout); whichever fired first rejected,
 * and a throttled background tab made the two disagree. The countdown is now
 * display-only and the service alone rejects.
 *
 * Source-level assertion like the back-handler test: mounting the modal needs
 * Pinia and the whole call service stack.
 */
const source = (): string => readFileSync(resolve(__dirname, "../IncomingCallModal.vue"), "utf-8");

describe("IncomingCallModal — incoming deadline", () => {
  it("does not reject the call when its countdown reaches zero", () => {
    const start = source().indexOf("function startCountdown()");
    const end = source().indexOf("function stopCountdown()");
    const countdown = source().slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(countdown).not.toMatch(/rejectCall\(/);
  });

  it("the call service still owns the 30 s auto-reject", () => {
    const incoming = readFileSync(resolve(__dirname, "../../model/call-incoming.ts"), "utf-8");
    expect(incoming).toMatch(/armIncomingTimeout\(\(\) => \{[\s\S]*?rejectCall\(\);[\s\S]*?\}, 30_000\);/);
  });
});
