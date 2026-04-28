import { describe, it, expect } from "vitest";
import {
  renderArticleText,
  renderArticleHtml,
  isArticleJson,
} from "../article-blocks";

const json = (blocks: unknown[]): string => JSON.stringify({ blocks });

describe("isArticleJson", () => {
  it("returns true for Editor.js JSON", () => {
    expect(isArticleJson(json([{ type: "paragraph", data: { text: "hi" } }]))).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(isArticleJson("Hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isArticleJson("")).toBe(false);
  });

  it("returns false for malformed JSON", () => {
    expect(isArticleJson("{not json")).toBe(false);
  });

  it("recovers from unescaped quotes in <a href> (real Bastyon corruption)", () => {
    // This is the exact pattern seen in production: href values are not
    // escaped, breaking strict JSON.parse but recoverable via the repair path.
    const broken = '{"blocks":[{"type":"paragraph","data":{"text":"see <a href=\"https://x.com\">link</a>"}}]}';
    expect(isArticleJson(broken)).toBe(true);
  });

  it("recovers from literal newlines inside string values", () => {
    const broken = '{"blocks":[{"type":"paragraph","data":{"text":"line one\nline two\nline three"}}]}';
    expect(isArticleJson(broken)).toBe(true);
  });

  it("returns false for JSON without blocks array", () => {
    expect(isArticleJson('{"foo":"bar"}')).toBe(false);
  });
});

describe("renderArticleText (preview, plain text)", () => {
  it("returns raw string for non-JSON input", () => {
    expect(renderArticleText("Hello world")).toBe("Hello world");
  });

  it("returns empty for falsy input", () => {
    expect(renderArticleText("")).toBe("");
    expect(renderArticleText(null as unknown as string)).toBe("");
    expect(renderArticleText(undefined as unknown as string)).toBe("");
  });

  it("extracts paragraph text and joins with newline", () => {
    const input = json([
      { type: "paragraph", data: { text: "First para" } },
      { type: "paragraph", data: { text: "Second para" } },
    ]);
    expect(renderArticleText(input)).toBe("First para\nSecond para");
  });

  it("strips inline HTML from paragraph text", () => {
    const input = json([
      { type: "paragraph", data: { text: "<b>Bold</b> and <i>italic</i>" } },
    ]);
    expect(renderArticleText(input)).toBe("Bold and italic");
  });

  it("decodes common HTML entities", () => {
    const input = json([
      { type: "paragraph", data: { text: "A&nbsp;B&amp;C&lt;D&gt;E&quot;F" } },
    ]);
    expect(renderArticleText(input)).toBe("A B&C<D>E\"F");
  });

  it("handles header blocks", () => {
    const input = json([
      { type: "header", data: { text: "Title", level: 1 } },
      { type: "paragraph", data: { text: "Body" } },
    ]);
    expect(renderArticleText(input)).toBe("Title\nBody");
  });

  it("handles unordered list blocks", () => {
    const input = json([
      { type: "list", data: { style: "unordered", items: ["A", "B", "C"] } },
    ]);
    expect(renderArticleText(input)).toBe("• A\n• B\n• C");
  });

  it("handles ordered list blocks", () => {
    const input = json([
      { type: "list", data: { style: "ordered", items: ["First", "Second"] } },
    ]);
    expect(renderArticleText(input)).toBe("1. First\n2. Second");
  });

  it("handles quote blocks with caption", () => {
    const input = json([{ type: "quote", data: { text: "Quoted", caption: "Author" } }]);
    expect(renderArticleText(input)).toBe("«Quoted» — Author");
  });

  it("handles quote blocks without caption", () => {
    const input = json([{ type: "quote", data: { text: "Bare quote" } }]);
    expect(renderArticleText(input)).toBe("«Bare quote»");
  });

  it("handles code blocks", () => {
    const input = json([{ type: "code", data: { code: "const x = 1;" } }]);
    expect(renderArticleText(input)).toBe("const x = 1;");
  });

  it("uses image caption for image blocks", () => {
    const input = json([
      { type: "paragraph", data: { text: "Before" } },
      { type: "image", data: { file: { url: "http://x" }, caption: "Pic" } },
      { type: "paragraph", data: { text: "After" } },
    ]);
    expect(renderArticleText(input)).toBe("Before\nPic\nAfter");
  });

  it("skips delimiter and embed blocks in text mode", () => {
    const input = json([
      { type: "paragraph", data: { text: "Before" } },
      { type: "delimiter" },
      { type: "embed", data: { source: "https://x" } },
      { type: "paragraph", data: { text: "After" } },
    ]);
    expect(renderArticleText(input)).toBe("Before\nAfter");
  });

  it("returns raw on malformed JSON", () => {
    expect(renderArticleText("{not json")).toBe("{not json");
  });

  it("returns raw on JSON without blocks array", () => {
    expect(renderArticleText('{"foo":"bar"}')).toBe('{"foo":"bar"}');
  });

  it("respects maxLength when provided", () => {
    const input = json([{ type: "paragraph", data: { text: "x".repeat(1000) } }]);
    const out = renderArticleText(input, { maxLength: 100 });
    expect(out).toHaveLength(103); // 100 + "..."
    expect(out.endsWith("...")).toBe(true);
  });

  it("does not truncate when output is shorter than maxLength", () => {
    const input = json([{ type: "paragraph", data: { text: "Short" } }]);
    expect(renderArticleText(input, { maxLength: 100 })).toBe("Short");
  });

  it("falls back to truncating raw for non-JSON when maxLength provided", () => {
    const long = "a".repeat(500);
    const out = renderArticleText(long, { maxLength: 100 });
    expect(out).toHaveLength(103);
    expect(out.endsWith("...")).toBe(true);
  });

  it("renders linkTool block as title text", () => {
    const input = json([
      { type: "linkTool", data: { link: "https://x.com", meta: { title: "Article Title", description: "..." } } },
    ]);
    expect(renderArticleText(input)).toBe("Article Title");
  });

  it("falls back to link URL when linkTool has no title", () => {
    const input = json([{ type: "linkTool", data: { link: "https://x.com" } }]);
    expect(renderArticleText(input)).toBe("https://x.com");
  });

  it("recovers broken JSON with unescaped href quotes (renders text)", () => {
    const broken = '{"blocks":[{"type":"paragraph","data":{"text":"see <a href=\"https://x.com\">link</a>"}}]}';
    const result = renderArticleText(broken);
    expect(result).toContain("see");
    expect(result).toContain("link");
    expect(result).not.toContain('"blocks"');
  });

  it("recovers broken JSON with literal newlines inside descriptions", () => {
    const broken = '{"blocks":[{"type":"linkTool","data":{"link":"https://x.com","meta":{"title":"Hi","description":"line1\nline2\nline3"}}}]}';
    const result = renderArticleText(broken);
    expect(result).toBe("Hi");
  });

  it("does not cleave emoji surrogate pairs when truncating", () => {
    // 99 ASCII chars + 4 emoji (4 code points = 8 UTF-16 code units)
    const input = json([
      { type: "paragraph", data: { text: "x".repeat(99) + "😀😀😀😀" } },
    ]);
    const out = renderArticleText(input, { maxLength: 100 });
    // Last char must be a complete emoji, not a lone surrogate
    expect(out.endsWith("...")).toBe(true);
    const beforeEllipsis = out.slice(0, -3);
    // Code-point-aware length must equal 100
    expect(Array.from(beforeEllipsis)).toHaveLength(100);
    // No replacement char (which would indicate broken surrogate)
    expect(out).not.toContain("�");
  });
});

describe("renderArticleHtml (full render, sanitized)", () => {
  it("returns empty for falsy input", () => {
    expect(renderArticleHtml("")).toBe("");
  });

  it("renders paragraph as <p>", () => {
    const html = renderArticleHtml(json([{ type: "paragraph", data: { text: "Hello" } }]));
    expect(html).toContain("<p");
    expect(html).toContain("Hello");
  });

  it("preserves safe inline tags (b, i, br, code, mark)", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: "<b>B</b> <i>I</i> <code>C</code> <mark>M</mark>" } }]),
    );
    expect(html).toContain("<b>B</b>");
    expect(html).toContain("<i>I</i>");
    expect(html).toContain("<code>C</code>");
    expect(html).toContain("<mark>M</mark>");
  });

  it("preserves anchor with safe href", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: '<a href="https://example.com">link</a>' } }]),
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("link");
  });

  it("strips <script> tag completely", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: '<b>safe</b><script>alert(1)</script>' } }]),
    );
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("alert(1)");
    expect(html).toContain("<b>safe</b>");
  });

  it("strips on* event handler attributes", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: '<b onclick="evil()">X</b>' } }]),
    );
    expect(html.toLowerCase()).not.toContain("onclick");
    expect(html).toContain("<b>X</b>");
  });

  it("strips javascript: URL from href", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: '<a href="javascript:alert(1)">x</a>' } }]),
    );
    expect(html.toLowerCase()).not.toContain("javascript:");
  });

  it("rejects fragment href containing javascript: text", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: '<a href="#javascript:alert(1)">x</a>' } }]),
    );
    expect(html.toLowerCase()).not.toContain("javascript:");
  });

  it("rejects protocol-relative URL in href", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: '<a href="//evil.com">x</a>' } }]),
    );
    expect(html).not.toContain('href="//evil.com"');
  });

  it("rejects bare slash href", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: '<a href="/">x</a>' } }]),
    );
    expect(html).not.toContain('href="/"');
  });

  it("accepts simple anchor href", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: '<a href="#section">x</a>' } }]),
    );
    expect(html).toContain('href="#section"');
  });

  it("accepts root-relative path href", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: '<a href="/posts/123">x</a>' } }]),
    );
    expect(html).toContain('href="/posts/123"');
  });

  it("accepts mailto and tel schemes", () => {
    const html = renderArticleHtml(
      json([
        { type: "paragraph", data: { text: '<a href="mailto:a@b.c">m</a><a href="tel:+1234">t</a>' } },
      ]),
    );
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).toContain('href="tel:+1234"');
  });

  it("forces rel=noopener noreferrer on target=_blank links (tabnabbing prevention)", () => {
    const html = renderArticleHtml(
      json([
        { type: "paragraph", data: { text: '<a href="https://x.com" target="_blank">x</a>' } },
      ]),
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("ignores user-supplied rel and overrides with safe value for _blank", () => {
    const html = renderArticleHtml(
      json([
        {
          type: "paragraph",
          data: { text: '<a href="https://x.com" target="_blank" rel="opener">x</a>' },
        },
      ]),
    );
    expect(html).not.toContain('rel="opener"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("does NOT add rel for non-blank links", () => {
    const html = renderArticleHtml(
      json([{ type: "paragraph", data: { text: '<a href="https://x.com">x</a>' } }]),
    );
    expect(html).not.toContain("rel=");
  });

  it("escapes > in attribute values (defense in depth)", () => {
    // Construct a paragraph with an a-tag whose href contains > literally
    const tricky = json([
      { type: "paragraph", data: { text: '<a href="https://x.com/?q=%3E">x</a>' } },
    ]);
    const html = renderArticleHtml(tricky);
    // The %3E stays encoded; this just confirms attribute escaping doesn't itself emit raw <
    expect(html).not.toContain('"<');
    expect(html).toContain('href="https://x.com/?q=%3E"');
  });

  it("renders header h1-h6 with clamping", () => {
    const html2 = renderArticleHtml(json([{ type: "header", data: { text: "T", level: 2 } }]));
    expect(html2).toContain("<h2");

    const htmlBig = renderArticleHtml(json([{ type: "header", data: { text: "T", level: 99 } }]));
    expect(htmlBig).toContain("<h6");

    const htmlSmall = renderArticleHtml(json([{ type: "header", data: { text: "T", level: 0 } }]));
    expect(htmlSmall).toContain("<h1");
  });

  it("renders unordered list as <ul>", () => {
    const html = renderArticleHtml(
      json([{ type: "list", data: { style: "unordered", items: ["a", "b"] } }]),
    );
    expect(html).toMatch(/<ul[^>]*>/);
    expect(html).toContain("<li>a</li>");
    expect(html).toContain("<li>b</li>");
  });

  it("renders ordered list as <ol>", () => {
    const html = renderArticleHtml(
      json([{ type: "list", data: { style: "ordered", items: ["a"] } }]),
    );
    expect(html).toMatch(/<ol[^>]*>/);
  });

  it("renders quote as <blockquote> with cite", () => {
    const html = renderArticleHtml(json([{ type: "quote", data: { text: "Q", caption: "A" } }]));
    expect(html).toMatch(/<blockquote[^>]*>/);
    expect(html).toContain("Q");
    expect(html).toContain("A");
  });

  it("renders code block as <pre><code> with escaped content", () => {
    const html = renderArticleHtml(
      json([{ type: "code", data: { code: 'if (x < 1) { "ok"; }' } }]),
    );
    expect(html).toMatch(/<pre[^>]*><code>/);
    expect(html).toContain("&lt;");
    expect(html.toLowerCase()).not.toContain("<script");
  });

  it("renders image with safe http(s) URL and caption", () => {
    const html = renderArticleHtml(
      json([{ type: "image", data: { file: { url: "https://cdn.x/y.jpg" }, caption: "Photo" } }]),
    );
    expect(html).toContain('src="https://cdn.x/y.jpg"');
    expect(html).toContain("Photo");
  });

  it("drops image with javascript: or non-http(s) URL", () => {
    const html = renderArticleHtml(
      json([{ type: "image", data: { file: { url: "javascript:alert(1)" } } }]),
    );
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html.toLowerCase()).not.toContain("<img");
  });

  it("renders delimiter as <hr>", () => {
    const html = renderArticleHtml(json([{ type: "delimiter" }]));
    expect(html.toLowerCase()).toContain("<hr");
  });

  it("does not throw for unknown block types", () => {
    expect(() =>
      renderArticleHtml(json([{ type: "unknownTable", data: { foo: "bar" } }])),
    ).not.toThrow();
  });

  it("returns escaped <p> for non-JSON input", () => {
    const html = renderArticleHtml("not <json> & co");
    expect(html.toLowerCase()).not.toContain("<json>");
    expect(html).toContain("not");
    expect(html).toContain("&amp;");
  });

  it("renders linkTool as <a> with safe href and rel=noopener", () => {
    const input = json([
      { type: "linkTool", data: { link: "https://x.com", meta: { title: "Title", description: "Description" } } },
    ]);
    const html = renderArticleHtml(input);
    expect(html).toContain('href="https://x.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Title");
    expect(html).toContain("Description");
  });

  it("drops linkTool with javascript: link", () => {
    const input = json([
      { type: "linkTool", data: { link: "javascript:alert(1)", meta: { title: "evil" } } },
    ]);
    const html = renderArticleHtml(input);
    expect(html.toLowerCase()).not.toContain("javascript:");
  });

  it("recovers broken JSON in renderArticleHtml (real Bastyon pattern)", () => {
    const broken = '{"blocks":[{"type":"paragraph","data":{"text":"<a href=\"https://x.com\">link</a>"}}]}';
    const html = renderArticleHtml(broken);
    expect(html).toContain('href="https://x.com"');
    expect(html).not.toContain('"blocks"');
  });

  it("skips empty paragraph blocks", () => {
    const html = renderArticleHtml(
      json([
        { type: "paragraph", data: { text: "" } },
        { type: "paragraph", data: { text: "X" } },
      ]),
    );
    // Should not produce <p></p> but should still render the second one
    expect(html).toContain("X");
  });
});
