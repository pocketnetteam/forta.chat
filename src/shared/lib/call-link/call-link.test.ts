import { describe, it, expect } from "vitest";
import { buildCallLinkBody, parseCallLinkBody, callLinkPreview, CALL_LINK_MARKER } from "./index";
import type { CallLinkInfo } from "@/entities/chat/model/types";

const sample: CallLinkInfo = {
  url: "https://zoom.us/j/1234567890",
  label: "Личный Zoom",
};

describe("call-link encoding", () => {
  it("round-trips build → parse", () => {
    const body = buildCallLinkBody(sample);
    expect(body.startsWith(CALL_LINK_MARKER)).toBe(true);
    expect(parseCallLinkBody(body)).toEqual(sample);
  });

  it("returns null for plain text bodies", () => {
    expect(parseCallLinkBody("hello world")).toBeNull();
    expect(parseCallLinkBody("https://zoom.us/j/123")).toBeNull();
  });

  it("returns null for transfer envelopes (no cross-detection)", () => {
    expect(parseCallLinkBody('{"_transfer":true,"amount":5}')).toBeNull();
  });

  it("rejects malformed envelopes without throwing", () => {
    expect(parseCallLinkBody('{"_callLink":true')).toBeNull();           // truncated JSON
    expect(parseCallLinkBody('{"_callLink":true}')).toBeNull();          // no url
    expect(parseCallLinkBody('{"_callLink":true,"label":"X"}')).toBeNull(); // no url
  });

  it("rejects non-http(s) URL schemes from a peer (security)", () => {
    const base = (url: string) => `{"_callLink":true,"url":"${url}","label":"x"}`;
    expect(parseCallLinkBody(base("javascript:alert(1)"))).toBeNull();
    expect(parseCallLinkBody(base("data:text/html,<script>"))).toBeNull();
    expect(parseCallLinkBody(base("file:///etc/passwd"))).toBeNull();
    expect(parseCallLinkBody(base("https://meet.jit.si/room"))?.url).toBe("https://meet.jit.si/room");
  });

  it("falls back label → url when label missing", () => {
    const body = '{"_callLink":true,"url":"https://meet.jit.si/room"}';
    expect(parseCallLinkBody(body)?.label).toBe("https://meet.jit.si/room");
  });

  it("builds a human-readable preview", () => {
    expect(callLinkPreview(sample)).toBe("📞 Личный Zoom");
  });
});
