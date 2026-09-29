import { describe, it, expect } from "vitest";
import { parseTextLinks, truncateLinkSegments, linkifyToHtml } from "./linkify";

describe("parseTextLinks", () => {
  it("returns [] for empty input", () => {
    expect(parseTextLinks("")).toEqual([]);
  });

  it("splits text and links in order", () => {
    expect(parseTextLinks("a https://x.com/p b")).toEqual([
      { type: "text", content: "a " },
      { type: "link", content: "https://x.com/p", href: "https://x.com/p" },
      { type: "text", content: " b" },
    ]);
  });

  it("prefixes www. links with https", () => {
    expect(parseTextLinks("www.site.org")).toEqual([
      { type: "link", content: "www.site.org", href: "https://www.site.org" },
    ]);
  });

  it("keeps trailing sentence punctuation out of the link", () => {
    expect(parseTextLinks("see https://x.com/a.")).toEqual([
      { type: "text", content: "see " },
      { type: "link", content: "https://x.com/a", href: "https://x.com/a" },
      { type: "text", content: "." },
    ]);
  });

  it("drops an unbalanced closing paren but keeps balanced ones", () => {
    const wrapped = parseTextLinks("(https://x.com/a)");
    expect(wrapped[1]).toMatchObject({ type: "link", href: "https://x.com/a" });
    expect(wrapped[2]).toEqual({ type: "text", content: ")" });

    const wiki = parseTextLinks("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(wiki).toEqual([
      { type: "link", content: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_(bar)" },
    ]);
  });

  it("leaves unsafe (private host) URLs as plain text", () => {
    expect(parseTextLinks("http://localhost:8080/x")).toEqual([
      { type: "text", content: "http://localhost:8080/x" },
    ]);
  });
});

describe("truncateLinkSegments", () => {
  it("returns segments untouched when within the limit", () => {
    const segs = parseTextLinks("hi https://x.com");
    expect(truncateLinkSegments(segs, 100)).toEqual(segs);
  });

  it("cuts plain text with an ellipsis", () => {
    expect(truncateLinkSegments([{ type: "text", content: "abcdef" }], 3)).toEqual([
      { type: "text", content: "abc..." },
    ]);
  });

  it("shortens a cut link's label but keeps its full href", () => {
    const out = truncateLinkSegments(parseTextLinks("ab https://example.com/long"), 10);
    expect(out).toEqual([
      { type: "text", content: "ab " },
      { type: "link", content: "https:/...", href: "https://example.com/long" },
    ]);
  });
});

describe("linkifyToHtml", () => {
  it("escapes HTML and wraps links in external anchors", () => {
    expect(linkifyToHtml("<b>x</b> https://x.com/?a=1&b=2")).toBe(
      '&lt;b&gt;x&lt;/b&gt; <a href="https://x.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://x.com/?a=1&amp;b=2</a>',
    );
  });

  it("does not let a quote break out of the href attribute", () => {
    const html = linkifyToHtml('https://x.com/a"onmouseover="alert(1)');
    expect(html).not.toContain('"onmouseover');
  });
});
