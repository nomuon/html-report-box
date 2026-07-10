/**
 * ScanContext — the document is parsed exactly once with parse5 (same parser
 * the platform uses for metadata extraction, so interpretation cannot
 * diverge) and every Rule consumes the resulting structure. Portable (Node 22).
 */
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { extractUrlsFromCode, externalHost, parseUrl } from "./url.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

export type ScanDocType = "html" | "svg" | "js";

export interface ScriptInfo {
  /** Raw src attribute (external or relative). */
  src?: string;
  /** Inline code, when the element has a body and an executable type. */
  code?: string;
  inSvg: boolean;
}

export interface FormInfo {
  /** action attribute plus any formaction overrides found inside the form. */
  actions: string[];
  hasPasswordInput: boolean;
}

export interface AnchorInfo {
  href?: string;
  /** download attribute value ("" when present without value). */
  download?: string;
  hasDownload: boolean;
}

export interface MetaRefreshInfo {
  delaySeconds: number;
  url: string;
}

export interface IframeInfo {
  src?: string;
  hidden: boolean;
}

export interface DataUriRef {
  tag: string;
  attr: string;
  value: string;
  /** true when the ref is an <a download> (payload smuggling vector). */
  download: boolean;
  /** true when the browser would navigate/execute it (a/iframe/embed/object/frame). */
  navigable: boolean;
}

export interface ScanContext {
  docType: ScanDocType;
  /** zip entry path when scanning an archive member. */
  entryPath?: string;
  title: string;
  /** Visible text, whitespace-normalized, lower-cased (brand vocabulary matching). */
  textLower: string;
  scripts: ScriptInfo[];
  /** Inline scripts + on* handlers + javascript: URL bodies (JS pattern rules). */
  codeBlobs: string[];
  forms: FormInfo[];
  anchors: AnchorInfo[];
  metaRefresh: MetaRefreshInfo[];
  iframes: IframeInfo[];
  dataUris: DataUriRef[];
  /** Absolute http(s) URLs from attributes and code literals. */
  urls: string[];
  /** Password inputs that live outside any <form>. */
  orphanPasswordInputs: number;
  /** <script> elements inside SVG content. */
  svgScripts: number;
  /** on* handlers / javascript: hrefs inside SVG content. */
  svgEventHandlers: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Attributes that may carry a URL. */
const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "data",
  "poster",
  "background",
  "xlink:href",
]);

/** script type values that execute as JS (empty/missing type executes too). */
function isExecutableScriptType(type: string | undefined): boolean {
  if (type === undefined || type.trim() === "") return true;
  return /^(?:text\/javascript|application\/(?:x-)?(?:java|ecma)script|text\/ecmascript|module)$/i.test(
    type.trim(),
  );
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
  if ("childNodes" in node) for (const child of node.childNodes) out += textContent(child);
  return out;
}

function isHiddenStyle(style: string | undefined): boolean {
  if (!style) return false;
  const s = style.toLowerCase();
  return (
    /display\s*:\s*none/.test(s) ||
    /visibility\s*:\s*hidden/.test(s) ||
    /opacity\s*:\s*0(?:\.0*)?(?:\s*[;!]|$)/.test(s) ||
    /(?:^|[;{\s])(?:width|height)\s*:\s*0(?:px|%)?\s*(?:[;!]|$)/.test(s) ||
    /(?:left|top)\s*:\s*-\d{3,}/.test(s)
  );
}

function isHiddenDimension(value: string | undefined): boolean {
  if (value === undefined) return false;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n <= 2;
}

function parseMetaRefresh(content: string): MetaRefreshInfo | null {
  // Aligned with the WHATWG shared declarative refresh algorithm: the time may
  // omit an integer part (".5"), and the time/URL separator is ';', ',' OR any
  // ASCII whitespace. The stricter `\d+(?:\.\d+)?` + `[;,]` regex let both
  // `.5;url=…` and `0 url=…` (which browsers navigate on) slip past the rule.
  const match = /^\s*(\d*\.?\d+)(?:[;,\s]+(?:url\s*=\s*)?['"]?([^'">\s]+))?/i.exec(content);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return { delaySeconds: Number.parseFloat(match[1]), url: match[2] };
}

const SKIPPED_TEXT_SUBTREES = new Set(["script", "style", "noscript", "template"]);

export function buildScanContext(
  source: string,
  opts: { docType?: "html" | "svg"; entryPath?: string } = {},
): ScanContext {
  const docType = opts.docType ?? "html";
  const ctx: ScanContext = {
    docType,
    ...(opts.entryPath !== undefined ? { entryPath: opts.entryPath } : {}),
    title: "",
    textLower: "",
    scripts: [],
    codeBlobs: [],
    forms: [],
    anchors: [],
    metaRefresh: [],
    iframes: [],
    dataUris: [],
    urls: [],
    orphanPasswordInputs: 0,
    svgScripts: 0,
    svgEventHandlers: 0,
  };

  const document = parse(source);
  const textChunks: string[] = [];

  const addUrlValue = (el: Element, attrName: string, value: string, inSvg: boolean): void => {
    // Browsers strip ASCII TAB/LF/CR from anywhere in a URL before resolving
    // its scheme, so `java&#9;script:` and `da&#9;ta:` are executable schemes.
    // Normalize first so classification matches the parseUrl() used below and
    // the browser — otherwise a control char smuggles the value past both
    // buckets and every downstream rule silently misses it.
    const normalized = value.replace(/[\t\n\r]/g, "");
    const trimmed = normalized.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("javascript:")) {
      const body = trimmed.slice("javascript:".length);
      if (body.trim()) ctx.codeBlobs.push(body);
      if (inSvg) ctx.svgEventHandlers += 1;
      return;
    }
    if (lower.startsWith("data:")) {
      const tag = el.tagName.toLowerCase();
      const hasDownload = tag === "a" && attr(el, "download") !== undefined;
      ctx.dataUris.push({
        tag,
        attr: attrName,
        value: trimmed,
        download: hasDownload,
        navigable:
          tag === "iframe" ||
          tag === "frame" ||
          tag === "embed" ||
          tag === "object" ||
          (tag === "a" && attrName === "href"),
      });
      return;
    }
    const url = parseUrl(trimmed);
    if (url && (url.protocol === "http:" || url.protocol === "https:")) {
      if (externalHost(trimmed) !== null) ctx.urls.push(url.href);
    }
  };

  const visit = (node: Node, state: { form: FormInfo | null; inSvg: boolean }): void => {
    let { form, inSvg } = state;

    if (isTextNode(node)) {
      const value = node.value.trim();
      if (value) textChunks.push(value);
      return;
    }

    if (isElement(node)) {
      const rawTag = node.tagName.toLowerCase();
      // Foreign (SVG/MathML) content can carry a namespace prefix, e.g.
      // `<s:script>` / `<s:svg xmlns:s="…/2000/svg">`. parse5 in HTML mode
      // keeps the prefix in tagName and does not set namespaceURI to SVG_NS,
      // so key off the local name to keep the svg-script detection honest.
      const tag = rawTag.includes(":") ? (rawTag.split(":").pop() ?? rawTag) : rawTag;
      const elInSvg = inSvg || node.namespaceURI === SVG_NS || tag === "svg";
      inSvg = elInSvg;

      // ---- attribute sweep: handlers + URLs ----
      for (const a of node.attrs) {
        const name = a.name.toLowerCase();
        if (name.startsWith("on") && a.value.trim()) {
          ctx.codeBlobs.push(a.value);
          if (elInSvg) ctx.svgEventHandlers += 1;
        } else if (URL_ATTRS.has(name)) {
          addUrlValue(node, name, a.value, elInSvg);
        } else if (name === "srcset") {
          for (const candidate of a.value.split(",")) {
            const urlPart = candidate.trim().split(/\s+/, 1)[0];
            if (urlPart) addUrlValue(node, "srcset", urlPart, elInSvg);
          }
        }
      }

      switch (tag) {
        case "title": {
          if (!ctx.title) ctx.title = textContent(node).replace(/\s+/g, " ").trim();
          return;
        }
        case "script": {
          const src = attr(node, "src");
          if (src !== undefined && src.trim() !== "") {
            ctx.scripts.push({ src: src.trim(), inSvg: elInSvg });
            if (elInSvg) ctx.svgScripts += 1;
          } else if (isExecutableScriptType(attr(node, "type"))) {
            const code = textContent(node);
            ctx.scripts.push({ code, inSvg: elInSvg });
            if (code.trim()) ctx.codeBlobs.push(code);
            if (elInSvg) ctx.svgScripts += 1;
            for (const url of extractUrlsFromCode(code)) ctx.urls.push(url);
          }
          return; // script text is never body text
        }
        case "form": {
          const action = attr(node, "action");
          const info: FormInfo = {
            actions: action !== undefined && action.trim() !== "" ? [action.trim()] : [],
            hasPasswordInput: false,
          };
          ctx.forms.push(info);
          form = info;
          break;
        }
        case "input": {
          if ((attr(node, "type") ?? "").trim().toLowerCase() === "password") {
            if (form) form.hasPasswordInput = true;
            else ctx.orphanPasswordInputs += 1;
          }
          const formaction = attr(node, "formaction");
          if (form && formaction && formaction.trim()) form.actions.push(formaction.trim());
          break;
        }
        case "button": {
          const formaction = attr(node, "formaction");
          if (form && formaction && formaction.trim()) form.actions.push(formaction.trim());
          break;
        }
        case "a": {
          const href = attr(node, "href");
          const download = attr(node, "download");
          ctx.anchors.push({
            ...(href !== undefined ? { href: href.trim() } : {}),
            ...(download !== undefined ? { download } : {}),
            hasDownload: download !== undefined,
          });
          break;
        }
        case "meta": {
          if ((attr(node, "http-equiv") ?? "").trim().toLowerCase() === "refresh") {
            const content = attr(node, "content");
            if (content) {
              const refresh = parseMetaRefresh(content);
              if (refresh) {
                ctx.metaRefresh.push(refresh);
                const url = parseUrl(refresh.url);
                if (url && externalHost(refresh.url) !== null) ctx.urls.push(url.href);
              }
            }
          }
          return;
        }
        case "iframe":
        case "frame": {
          const src = attr(node, "src");
          const hidden =
            attr(node, "hidden") !== undefined ||
            isHiddenStyle(attr(node, "style")) ||
            isHiddenDimension(attr(node, "width")) ||
            isHiddenDimension(attr(node, "height"));
          ctx.iframes.push({
            ...(src !== undefined && src.trim() !== "" ? { src: src.trim() } : {}),
            hidden: hidden || hiddenAncestors > 0,
          });
          break;
        }
        default:
          break;
      }

      if (SKIPPED_TEXT_SUBTREES.has(tag)) return;

      const hiddenHere = isHiddenStyle(attr(node, "style")) || attr(node, "hidden") !== undefined;
      if (hiddenHere) hiddenAncestors += 1;
      if ("childNodes" in node) {
        for (const child of node.childNodes) visit(child, { form, inSvg });
      }
      const template = (node as Element & { content?: { childNodes: Node[] } }).content;
      if (template) for (const child of template.childNodes) visit(child, { form, inSvg });
      if (hiddenHere) hiddenAncestors -= 1;
      return;
    }

    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child, { form, inSvg });
    }
  };

  let hiddenAncestors = 0;
  visit(document, { form: null, inSvg: docType === "svg" });

  ctx.textLower = textChunks.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  ctx.urls = [...new Set(ctx.urls)];
  return ctx;
}

/** Minimal context for standalone .js zip entries — JS rules run, DOM rules no-op. */
export function buildJsContext(code: string, entryPath: string): ScanContext {
  return {
    docType: "js",
    entryPath,
    title: "",
    textLower: "",
    scripts: [{ code, inSvg: false }],
    codeBlobs: code.trim() ? [code] : [],
    forms: [],
    anchors: [],
    metaRefresh: [],
    iframes: [],
    dataUris: [],
    urls: [...new Set(extractUrlsFromCode(code))],
    orphanPasswordInputs: 0,
    svgScripts: 0,
    svgEventHandlers: 0,
  };
}
