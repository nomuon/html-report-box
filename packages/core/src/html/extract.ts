/**
 * HTML metadata / text extraction with parse5 (same parser the scanner uses,
 * so document interpretation cannot diverge). Portable (Node 22).
 */
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

export interface HtmlExtraction {
  /** <title> text, if present and non-empty. */
  title: string | undefined;
  /** <meta name="description"> (or og:description) content, if present. */
  description: string | undefined;
  /** Visible text content (scripts/styles/templates excluded), whitespace-normalized. */
  text: string;
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function isTextNode(node: Node): node is TextNode {
  return node.nodeName === "#text";
}

function attr(el: Element, name: string): string | undefined {
  for (const a of el.attrs) {
    if (a.name.toLowerCase() === name) return a.value;
  }
  return undefined;
}

function textContent(node: Node): string {
  if (isTextNode(node)) return node.value;
  let out = "";
  if ("childNodes" in node) {
    for (const child of node.childNodes) out += textContent(child);
  }
  return out;
}

/** Subtrees whose text must never reach the search index. */
const SKIPPED_SUBTREES = new Set(["script", "style", "noscript", "template", "iframe", "object"]);

export function extractHtml(html: string): HtmlExtraction {
  const document = parse(html);

  let title: string | undefined;
  let description: string | undefined;
  const chunks: string[] = [];

  const visit = (node: Node): void => {
    if (isTextNode(node)) {
      const value = node.value.trim();
      if (value) chunks.push(value);
      return;
    }
    if (isElement(node)) {
      const tag = node.tagName.toLowerCase();
      if (tag === "title") {
        if (title === undefined) {
          const t = textContent(node).replace(/\s+/g, " ").trim();
          if (t) title = t;
        }
        return; // title text is not body text
      }
      if (tag === "meta") {
        const name = attr(node, "name")?.toLowerCase() ?? attr(node, "property")?.toLowerCase();
        if (description === undefined && (name === "description" || name === "og:description")) {
          const content = attr(node, "content")?.trim();
          if (content) description = content;
        }
        return;
      }
      if (SKIPPED_SUBTREES.has(tag)) return;
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
  };

  visit(document);

  return {
    title,
    description,
    text: chunks.join(" ").replace(/\s+/g, " ").trim(),
  };
}
