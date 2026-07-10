/**
 * Zip extractor tests. Archives are generated in-memory with fflate (dev
 * dependency); the implementation under test uses yauzl. Every limit is
 * asserted against MEASURED output, not declared header sizes.
 */
import { describe, expect, test } from "bun:test";
import { zipSync, type Zippable, type ZipAttributes } from "fflate";
import { createZipExtractor } from "./extractor.ts";
import { ZipValidationError, type ZipValidationCode } from "./errors.ts";

const enc = new TextEncoder();

type Entry = Uint8Array | [Uint8Array, ZipAttributes];

function makeZip(entries: Record<string, Entry>): Uint8Array {
  return zipSync(entries as Zippable, { level: 6 });
}

async function expectRejectCode(
  data: Uint8Array,
  code: ZipValidationCode,
  extractor = createZipExtractor(),
): Promise<void> {
  try {
    await extractor.extract(data);
  } catch (err) {
    expect(err).toBeInstanceOf(ZipValidationError);
    expect((err as ZipValidationError).zipCode).toBe(code);
    return;
  }
  throw new Error(`expected extraction to reject with ${code}`);
}

describe("valid archive", () => {
  test("returns normalized entries including root index.html", async () => {
    const zip = makeZip({
      "index.html": enc.encode("<!doctype html><title>ok</title><h1>Hi</h1>"),
      "assets/app.css": enc.encode("body{color:#333}"),
      "app.js": enc.encode("console.log(1)"),
    });
    const files = await createZipExtractor().extract(zip);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["app.js", "assets/app.css", "index.html"]);
    const index = files.find((f) => f.path === "index.html");
    expect(new TextDecoder().decode(index!.data)).toContain("<h1>Hi</h1>");
  });
});

describe("zip-slip", () => {
  test("parent-directory traversal is rejected", async () => {
    const zip = makeZip({
      "index.html": enc.encode("<title>x</title>"),
      "../escape.html": enc.encode("<title>evil</title>"),
    });
    await expectRejectCode(zip, "zip_slip");
  });

  test("absolute path is rejected", async () => {
    const zip = makeZip({
      "index.html": enc.encode("<title>x</title>"),
      "/etc/evil.html": enc.encode("<title>evil</title>"),
    });
    await expectRejectCode(zip, "zip_slip");
  });

  test("symlink entry is rejected", async () => {
    const S_IFLNK = 0xa000;
    const symlinkAttrs: ZipAttributes = { os: 3, attrs: ((S_IFLNK | 0o777) << 16) >>> 0 };
    const zip = makeZip({
      "index.html": enc.encode("<title>x</title>"),
      "link.html": [enc.encode("/etc/passwd"), symlinkAttrs],
    });
    await expectRejectCode(zip, "symlink_entry");
  });
});

describe("zip bombs (measured, not declared)", () => {
  test("total uncompressed size over the limit", async () => {
    const big = new Uint8Array(4096).fill(0x41);
    const zip = makeZip({ "index.html": enc.encode("<title>x</title>"), "big.txt": big });
    // 2KB cap → 4KB entry trips the measured-size guard mid-stream.
    const extractor = createZipExtractor({ maxZipUncompressedBytes: 2048, minRatioCheckBytes: 1 << 30 });
    await expectRejectCode(zip, "zip_bomb_size", extractor);
  });

  test("entry count over the limit", async () => {
    const entries: Record<string, Uint8Array> = { "index.html": enc.encode("<title>x</title>") };
    for (let i = 0; i < 10; i += 1) entries[`f${i}.txt`] = enc.encode(String(i));
    const extractor = createZipExtractor({ maxZipEntries: 3 });
    await expectRejectCode(makeZip(entries), "zip_bomb_entries", extractor);
  });

  test("per-entry compression ratio over the limit", async () => {
    const zeros = new Uint8Array(1_000_000); // 1MB of 0x00 → deflates to ~1KB
    const zip = makeZip({ "index.html": enc.encode("<title>x</title>"), "zeros.txt": zeros });
    await expectRejectCode(zip, "zip_bomb_ratio");
  });
});

describe("nested zip", () => {
  test("rejected by .zip extension", async () => {
    const inner = makeZip({ "index.html": enc.encode("<title>x</title>") });
    const zip = makeZip({ "index.html": enc.encode("<title>x</title>"), "inner.zip": inner });
    await expectRejectCode(zip, "nested_zip");
  });

  test("rejected by content sniff even with a disguised extension", async () => {
    const inner = makeZip({ "index.html": enc.encode("<title>x</title>") });
    const zip = makeZip({ "index.html": enc.encode("<title>x</title>"), "inner.txt": inner });
    await expectRejectCode(zip, "nested_zip");
  });
});

describe("extension allowlist", () => {
  test("disallowed extension is rejected", async () => {
    const zip = makeZip({
      "index.html": enc.encode("<title>x</title>"),
      "notes.pdf": enc.encode("%PDF-1.4"),
    });
    await expectRejectCode(zip, "disallowed_extension");
  });
});

describe("root index.html requirement", () => {
  test("archive without a root index.html is rejected", async () => {
    const zip = makeZip({ "pages/index.html": enc.encode("<title>x</title>") });
    await expectRejectCode(zip, "missing_root_index");
  });
});

describe("corrupt input", () => {
  test("non-zip bytes are rejected as invalid_zip", async () => {
    await expectRejectCode(enc.encode("this is not a zip file at all"), "invalid_zip");
  });
});
