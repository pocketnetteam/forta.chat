/**
 * Editor.js block parsing for Bastyon article posts.
 *
 * Bastyon stores article bodies as Editor.js JSON in `post.message` when
 * `post.settings.v === "a"`. This module parses that JSON safely:
 *
 *  - `renderArticleText` → plain text for previews / list bubbles.
 *  - `renderArticleHtml` → sanitized HTML for full article view.
 *  - `isArticleJson`     → heuristic JSON-vs-plaintext check.
 *
 * Sanitization is whitelist-based and runs against a real DOM tree
 * (DOMParser, available in browser + happy-dom test env). Falls back
 * to a regex strip when DOMParser is unavailable.
 */

export interface RenderTextOptions {
  /** Truncate output to this length (adds "..." marker if cut). */
  maxLength?: number;
}

interface ParsedArticle {
  blocks: ArticleBlock[];
}

interface ArticleBlock {
  type?: string;
  data?: Record<string, unknown>;
}

/** Try to parse JSON; return null if malformed or not an Editor.js doc. */
function tryParseBlocks(input: string): ParsedArticle | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && Array.isArray(parsed.blocks)) {
      return parsed as ParsedArticle;
    }
    return null;
  } catch {
    return null;
  }
}

export function isArticleJson(input: string): boolean {
  return tryParseBlocks(input) !== null;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/** Strip HTML tags and decode common entities → plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos);/g, (m) => HTML_ENTITY_MAP[m] ?? m)
    .trim();
}

function applyMaxLength(text: string, maxLength?: number): string {
  if (maxLength == null) return text;
  // Use Array.from for code-point-aware truncation so emoji / surrogate pairs
  // never get cleaved in half.
  if (text.length <= maxLength) return text;
  const chars = Array.from(text);
  return chars.length > maxLength ? chars.slice(0, maxLength).join("") + "..." : text;
}

/**
 * Render Editor.js JSON to plain text. Falls back to raw input if not
 * valid Editor.js JSON. Respects optional maxLength truncation.
 */
export function renderArticleText(input: string, opts: RenderTextOptions = {}): string {
  if (!input) return "";

  const parsed = tryParseBlocks(input);
  if (!parsed) return applyMaxLength(input, opts.maxLength);

  const lines: string[] = [];
  for (const block of parsed.blocks) {
    const t = block.type;
    const d = block.data ?? {};
    switch (t) {
      case "paragraph":
      case "header": {
        const text = typeof d.text === "string" ? stripHtml(d.text) : "";
        if (text) lines.push(text);
        break;
      }
      case "list": {
        const items = Array.isArray(d.items) ? (d.items as unknown[]) : [];
        const ordered = d.style === "ordered";
        items.forEach((item, i) => {
          const stripped = typeof item === "string" ? stripHtml(item) : "";
          if (stripped) lines.push(ordered ? `${i + 1}. ${stripped}` : `• ${stripped}`);
        });
        break;
      }
      case "quote": {
        const text = typeof d.text === "string" ? stripHtml(d.text) : "";
        const caption = typeof d.caption === "string" ? stripHtml(d.caption) : "";
        if (text) lines.push(caption ? `«${text}» — ${caption}` : `«${text}»`);
        break;
      }
      case "code": {
        const code = typeof d.code === "string" ? d.code : "";
        if (code) lines.push(code);
        break;
      }
      case "image": {
        const caption = typeof d.caption === "string" ? stripHtml(d.caption) : "";
        if (caption) lines.push(caption);
        break;
      }
      // delimiter, embed, table → skip in text mode
      default:
        break;
    }
  }

  return applyMaxLength(lines.join("\n"), opts.maxLength);
}

/** Tag names allowed inside paragraph / list / quote / header text. */
const ALLOWED_INLINE_TAGS = new Set([
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "A",
  "BR",
  "CODE",
  "MARK",
  "SPAN",
]);

/**
 * Per-tag attribute whitelist. Note: `rel` is NOT in the whitelist for <a> —
 * we control it ourselves to force `noopener noreferrer` for `target="_blank"`,
 * preventing tabnabbing via `window.opener`.
 */
const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  A: new Set(["href", "target", "class"]),
  SPAN: new Set(["class"]),
};

/** Tags whose contents must be discarded entirely (not just unwrapped). */
const DANGEROUS_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "FORM",
  "INPUT",
  "BUTTON",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "META",
  "LINK",
  "BASE",
  "NOSCRIPT",
]);

/**
 * href must match this for safety. We deliberately reject:
 *  - javascript:, data:, vbscript: and other dangerous schemes
 *  - protocol-relative URLs (//host) — could escape origin
 *  - fragments containing arbitrary text (#javascript:...) — defense in depth
 *  - bare slash "/" with no path
 */
const SAFE_URL_RE = /^(?:https?:\/\/|mailto:|tel:|#[\w-]*$|\/[^/])/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Recursively serialize an element with whitelist filtering. */
function serializeNode(node: Node): string {
  if (node.nodeType === 3 /* TEXT */) {
    return escapeHtml(node.textContent ?? "");
  }
  if (node.nodeType !== 1 /* ELEMENT */) return "";

  const el = node as Element;
  const tag = el.tagName.toUpperCase();

  if (DANGEROUS_TAGS.has(tag)) {
    // Discard tag and its children entirely
    return "";
  }
  if (!ALLOWED_INLINE_TAGS.has(tag)) {
    // Drop the tag, keep its inner content
    return Array.from(el.childNodes).map(serializeNode).join("");
  }

  const attrParts: string[] = [];
  let isTargetBlank = false;
  const allowedAttrs = ALLOWED_ATTRS[tag];
  if (allowedAttrs) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!allowedAttrs.has(name)) continue;
      const value = attr.value;
      if (name === "href" && !SAFE_URL_RE.test(value)) continue;
      if (name === "target") {
        if (value !== "_blank" && value !== "_self") continue;
        if (value === "_blank") isTargetBlank = true;
      }
      attrParts.push(`${name}="${escapeAttr(value)}"`);
    }
  }

  // Force rel="noopener noreferrer" on anchors that open new tabs to prevent
  // tabnabbing (window.opener.location hijacks). User-supplied rel is ignored.
  if (tag === "A" && isTargetBlank) {
    attrParts.push('rel="noopener noreferrer"');
  }

  const innerHtml = Array.from(el.childNodes).map(serializeNode).join("");
  if (tag === "BR") return "<br/>";
  const lower = tag.toLowerCase();
  const attrStr = attrParts.length ? " " + attrParts.join(" ") : "";
  return `<${lower}${attrStr}>${innerHtml}</${lower}>`;
}

/** Sanitize inline HTML using DOMParser when available; fallback strips all tags. */
function sanitizeInline(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    return escapeHtml(stripHtml(html));
  }
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstChild as Element | null;
  if (!root) return "";
  return Array.from(root.childNodes).map(serializeNode).join("");
}

function renderHeaderLevel(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.min(Math.max(Math.floor(n), 1), 6);
}

/**
 * Render Editor.js JSON to sanitized HTML. Returns escaped <p> for
 * non-JSON input so the result is always safe to feed into v-html.
 */
export function renderArticleHtml(input: string): string {
  if (!input) return "";

  const parsed = tryParseBlocks(input);
  if (!parsed) return `<p class="article-p">${escapeHtml(input)}</p>`;

  const parts: string[] = [];
  for (const block of parsed.blocks) {
    const t = block.type;
    const d = block.data ?? {};

    switch (t) {
      case "paragraph": {
        const safe = sanitizeInline(typeof d.text === "string" ? d.text : "");
        if (safe.trim()) parts.push(`<p class="article-p">${safe}</p>`);
        break;
      }
      case "header": {
        const level = renderHeaderLevel(d.level);
        const safe = sanitizeInline(typeof d.text === "string" ? d.text : "");
        if (safe.trim()) parts.push(`<h${level} class="article-h">${safe}</h${level}>`);
        break;
      }
      case "list": {
        const items = Array.isArray(d.items) ? (d.items as unknown[]) : [];
        if (items.length === 0) break;
        const tag = d.style === "ordered" ? "ol" : "ul";
        const lis = items
          .map((it) => {
            const text = typeof it === "string" ? sanitizeInline(it) : "";
            return text ? `<li>${text}</li>` : "";
          })
          .filter(Boolean)
          .join("");
        if (lis) parts.push(`<${tag} class="article-list">${lis}</${tag}>`);
        break;
      }
      case "quote": {
        const text = sanitizeInline(typeof d.text === "string" ? d.text : "");
        const caption = sanitizeInline(typeof d.caption === "string" ? d.caption : "");
        if (text) {
          const cite = caption ? `<cite>— ${caption}</cite>` : "";
          parts.push(`<blockquote class="article-quote">${text}${cite}</blockquote>`);
        }
        break;
      }
      case "code": {
        const code = typeof d.code === "string" ? d.code : "";
        if (code) parts.push(`<pre class="article-code"><code>${escapeHtml(code)}</code></pre>`);
        break;
      }
      case "image": {
        const file = (d.file ?? {}) as Record<string, unknown>;
        const url = typeof file.url === "string" ? file.url : "";
        if (url && /^https?:\/\//i.test(url)) {
          const caption = typeof d.caption === "string" ? escapeHtml(d.caption) : "";
          const figcap = caption ? `<figcaption>${caption}</figcaption>` : "";
          parts.push(
            `<figure class="article-figure"><img src="${escapeAttr(url)}" alt="${caption}" loading="lazy"/>${figcap}</figure>`,
          );
        }
        break;
      }
      case "delimiter":
        parts.push('<hr class="article-hr"/>');
        break;
      // embed, table, raw → skipped (no whitelist)
      default:
        break;
    }
  }

  return parts.join("");
}
