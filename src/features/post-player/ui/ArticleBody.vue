<script setup lang="ts">
import { computed } from "vue";
import { renderArticleHtml, isArticleJson } from "@/shared/lib/article-blocks";

interface Props {
  /** Raw post.message — either Editor.js JSON or plain text. */
  raw: string;
  /** When true, even non-JSON input is wrapped in sanitized <p>. */
  forceWrap?: boolean;
}

const props = withDefaults(defineProps<Props>(), { forceWrap: false });

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const html = computed(() => {
  const raw = props.raw;
  if (!raw) return "";
  if (isArticleJson(raw)) return renderArticleHtml(raw);
  // Non-JSON: always escape; forceWrap only affects whether to wrap in <p>
  const safe = escapeHtml(raw);
  return props.forceWrap ? `<p class="article-p">${safe}</p>` : safe;
});
</script>

<template>
  <div class="article-body" v-html="html" />
</template>

<style scoped>
.article-body :deep(.article-p) {
  margin-bottom: 0.75rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.article-body :deep(.article-p:last-child) {
  margin-bottom: 0;
}
.article-body :deep(.article-h) {
  margin: 1rem 0 0.5rem;
  font-weight: 700;
  line-height: 1.3;
}
.article-body :deep(.article-list) {
  margin: 0 0 0.75rem;
  padding-left: 1.5rem;
}
.article-body :deep(.article-list li) {
  margin-bottom: 0.25rem;
  list-style-position: outside;
}
.article-body :deep(.article-quote) {
  border-left: 3px solid var(--color-bg-ac, #4a90e2);
  padding: 0.5rem 0.75rem;
  margin: 0.75rem 0;
  font-style: italic;
  opacity: 0.9;
}
.article-body :deep(.article-quote cite) {
  display: block;
  margin-top: 0.25rem;
  font-style: normal;
  font-size: 0.875em;
  opacity: 0.7;
}
.article-body :deep(.article-code) {
  background: rgba(0, 0, 0, 0.06);
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  overflow-x: auto;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.85em;
  margin: 0.5rem 0;
}
.article-body :deep(.article-figure) {
  margin: 0.75rem 0;
}
.article-body :deep(.article-figure img) {
  max-width: 100%;
  height: auto;
  border-radius: 0.5rem;
  display: block;
}
.article-body :deep(.article-figure figcaption) {
  margin-top: 0.25rem;
  font-size: 0.85em;
  opacity: 0.7;
  text-align: center;
}
.article-body :deep(.article-hr) {
  border: 0;
  border-top: 1px solid currentColor;
  opacity: 0.2;
  margin: 1rem 0;
}
.article-body :deep(a) {
  color: var(--color-bg-ac, #4a90e2);
  text-decoration: underline;
}
.article-body :deep(a:hover) {
  text-decoration: none;
}
</style>
