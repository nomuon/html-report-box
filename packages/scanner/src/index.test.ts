/**
 * Golden tests: every malicious fixture must block, every warn fixture must
 * warn, and the benign corpus must produce ZERO findings (false-positive
 * regression guard — new rules must keep this green).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { StubDomainReputation } from "@hrb/core/local";
import type { ScanVerdict } from "@hrb/shared";
import { createScanner, PACKAGE_NAME } from "./index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");

function fixture(kind: string, name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, kind, name)));
}

function listFixtures(kind: string): string[] {
  return readdirSync(join(FIXTURES, kind)).filter((f) => f.endsWith(".html"));
}

/** malicious-domain.html references known-bad.example.org — teach the stub. */
const domainReputation = new StubDomainReputation(["known-bad.example.org"]);
const scanner = createScanner({ domainReputation });

async function scanHtml(
  kind: string,
  name: string,
): Promise<{ verdict: ScanVerdict; rules: string[] }> {
  const result = await scanner.scan({ kind: "html", data: fixture(kind, name) });
  return { verdict: result.verdict, rules: result.findings.map((f) => f.ruleId) };
}

test("package name", () => {
  expect(PACKAGE_NAME).toBe("@hrb/scanner");
});

describe("malicious corpus → block", () => {
  const expectedRule: Record<string, string> = {
    "phishing-form.html": "phishing-form",
    "eval-atob.html": "decode-exec-chain",
    "meta-refresh.html": "meta-refresh-external",
    "hidden-iframe.html": "hidden-iframe",
    "svg-script.html": "svg-script",
    "executable-link.html": "executable-link",
    "miner.html": "miner-signature",
    "malicious-domain.html": "malicious-domain",
  };
  for (const name of listFixtures("malicious")) {
    test(name, async () => {
      const { verdict, rules } = await scanHtml("malicious", name);
      expect(verdict).toBe("block");
      const rule = expectedRule[name];
      if (rule) expect(rules).toContain(rule);
    });
  }
});

describe("warn corpus → warn (never block)", () => {
  const expectedRule: Record<string, string> = {
    "external-form.html": "external-form-action",
    "js-redirect.html": "js-redirect-external",
    "obfuscated.html": "obfuscation",
    "blob-download.html": "blob-download-chain",
    "unlisted-cdn.html": "external-script-src",
  };
  for (const name of listFixtures("warn")) {
    test(name, async () => {
      const { verdict, rules } = await scanHtml("warn", name);
      expect(verdict).toBe("warn");
      const rule = expectedRule[name];
      if (rule) expect(rules).toContain(rule);
    });
  }
});

describe("benign corpus → zero findings (false-positive guard)", () => {
  for (const name of listFixtures("benign")) {
    test(name, async () => {
      const result = await scanner.scan({ kind: "html", data: fixture("benign", name) });
      expect({ name, verdict: result.verdict, findings: result.findings }).toEqual({
        name,
        verdict: "pass",
        findings: [],
      });
    });
  }
});
