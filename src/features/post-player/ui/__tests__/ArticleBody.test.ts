import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ArticleBody from "../ArticleBody.vue";

const json = (blocks: unknown[]): string => JSON.stringify({ blocks });

describe("ArticleBody", () => {
  it("renders Editor.js paragraphs as readable text", () => {
    const w = mount(ArticleBody, {
      props: {
        raw: json([
          { type: "paragraph", data: { text: "First" } },
          { type: "header", data: { text: "Title", level: 2 } },
          { type: "paragraph", data: { text: "Second" } },
        ]),
      },
    });
    const text = w.text();
    expect(text).not.toContain('"blocks"');
    expect(text).not.toContain('"paragraph"');
    expect(text).toContain("First");
    expect(text).toContain("Title");
    expect(text).toContain("Second");
  });

  it("preserves safe inline tags via v-html", () => {
    const w = mount(ArticleBody, {
      props: {
        raw: json([
          { type: "paragraph", data: { text: '<b>Bold</b> <a href="https://x.com">link</a>' } },
        ]),
      },
    });
    expect(w.html()).toContain("<b>Bold</b>");
    expect(w.html()).toContain('href="https://x.com"');
  });

  it("strips dangerous content (script, onclick)", () => {
    const w = mount(ArticleBody, {
      props: {
        raw: json([
          { type: "paragraph", data: { text: '<script>alert(1)</script><b onclick="evil()">Click</b>' } },
        ]),
      },
    });
    const html = w.html().toLowerCase();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(1)");
    expect(w.html()).toContain("<b>Click</b>");
  });

  it("renders non-JSON input as-is when forceWrap=false (default)", () => {
    const w = mount(ArticleBody, {
      props: { raw: "Plain text message" },
    });
    expect(w.text()).toContain("Plain text message");
  });

  it("escapes HTML in non-JSON input safely", () => {
    const w = mount(ArticleBody, {
      props: { raw: "<script>alert(1)</script>plain" },
    });
    expect(w.html().toLowerCase()).not.toContain("<script");
  });

  it("renders empty for empty raw", () => {
    const w = mount(ArticleBody, { props: { raw: "" } });
    expect(w.text()).toBe("");
  });

  it("renders ordered list", () => {
    const w = mount(ArticleBody, {
      props: {
        raw: json([{ type: "list", data: { style: "ordered", items: ["A", "B"] } }]),
      },
    });
    expect(w.html()).toMatch(/<ol[^>]*>/);
    expect(w.text()).toContain("A");
    expect(w.text()).toContain("B");
  });

  it("renders quote as blockquote", () => {
    const w = mount(ArticleBody, {
      props: {
        raw: json([{ type: "quote", data: { text: "wisdom", caption: "sage" } }]),
      },
    });
    expect(w.html()).toMatch(/<blockquote[^>]*>/);
    expect(w.text()).toContain("wisdom");
    expect(w.text()).toContain("sage");
  });
});
