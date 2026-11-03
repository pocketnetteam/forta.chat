import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Audit S10-05 (owner decision 2026-10-10: Electron only, report-only first).
 * The app had no Content-Security-Policy anywhere. The packaged desktop app
 * now sends one as Content-Security-Policy-Report-Only on its own pages: it
 * blocks nothing, and every violation is logged, so the policy can be
 * tightened and switched to enforcing once the logs are clean.
 */
const require = createRequire(import.meta.url);
const root = resolve(__dirname, "../../../..");
const csp = require("../../../../electron/csp.cjs") as {
  CSP_REPORT_ONLY_POLICY: string;
  withReportOnlyCsp: (response: Response, pathname: string) => Response;
  isCspViolationMessage: (message: unknown) => boolean;
};

describe("Electron Content-Security-Policy (audit S10-05)", () => {
  it("adds the report-only header to the app's HTML pages and keeps body and status", async () => {
    const original = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = csp.withReportOnlyCsp(original, "/index.html");
    expect(out.headers.get("Content-Security-Policy-Report-Only")).toBe(csp.CSP_REPORT_ONLY_POLICY);
    expect(out.headers.get("Content-Security-Policy")).toBeNull();
    expect(out.headers.get("content-type")).toBe("text/html");
    expect(out.status).toBe(200);
    expect(await out.text()).toBe("<html></html>");
  });

  it("leaves other files alone", () => {
    const js = new Response("x", { headers: { "content-type": "text/javascript" } });
    expect(csp.withReportOnlyCsp(js, "/assets/index.js")).toBe(js);
  });

  it("starts from a policy that closes plugins and base hijacking", () => {
    expect(csp.CSP_REPORT_ONLY_POLICY).toContain("object-src 'none'");
    expect(csp.CSP_REPORT_ONLY_POLICY).toContain("base-uri 'self'");
    expect(csp.CSP_REPORT_ONLY_POLICY).toContain("default-src 'self'");
  });

  it("recognises the console line Chromium writes for a report-only violation", () => {
    expect(csp.isCspViolationMessage("[Report Only] Refused to load the script 'https://x' because it violates the following Content Security Policy directive")).toBe(true);
    expect(csp.isCspViolationMessage("hello")).toBe(false);
    expect(csp.isCspViolationMessage(undefined)).toBe(false);
  });

  it("is wired into the app:// handler and the window's console log", () => {
    const main = readFileSync(resolve(root, "electron/main.cjs"), "utf8");
    const handler = main.slice(main.indexOf('protocol.handle("app"'), main.indexOf('protocol.handle("app"') + 600);
    expect(handler).toContain("withReportOnlyCsp(");
    expect(main).toContain("isCspViolationMessage(");
  });

  it("does not spy on unrelated module state", () => {
    expect(vi.isMockFunction(csp.withReportOnlyCsp)).toBe(false);
  });
});
