/**
 * Zip extractor tests. Archives are generated in-memory with fflate; the
 * implementation under test also uses fflate (+ 自前 CDR パーサ). Every limit
 * is asserted against MEASURED output, not declared header sizes.
 */
import { describe, expect, test } from "bun:test";
import { zipSync, type Zippable, type ZipAttributes } from "fflate";
import { deflateSync } from "fflate";
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

/**
 * fflate's zipSync never emits data descriptors (GPBF bit 3) nor sets the
 * encrypted flag (GPBF bit 0), so these archives are assembled by hand with a
 * DataView to exercise the central-directory parser on those exact fields.
 */
const GPBF_ENCRYPTED = 0x0001;
const GPBF_DATA_DESCRIPTOR = 0x0008;

interface RawSpec {
  name: string;
  content: Uint8Array;
  flags: number;
  /** true = deflate + trailing data descriptor; false = stored, no descriptor. */
  deflate: boolean;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

/** Build a ZIP with explicit per-entry flags, optionally using data descriptors. */
function makeRawZip(specs: RawSpec[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const spec of specs) {
    const name = enc.encode(spec.name);
    const payload = spec.deflate ? deflateSync(spec.content) : spec.content;
    const method = spec.deflate ? 8 : 0;

    const lfh = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, spec.flags, true);
    lv.setUint16(8, method, true);
    // With a data descriptor, the local header carries zeroed crc/sizes.
    lv.setUint32(14, 0, true); // crc-32
    lv.setUint32(18, spec.deflate ? 0 : payload.byteLength, true); // compressed size
    lv.setUint32(22, spec.deflate ? 0 : spec.content.byteLength, true); // uncompressed size
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, 0, true); // extra length
    lfh.set(name, 30);
    local.push(lfh, payload);

    let recordSize = lfh.byteLength + payload.byteLength;
    if (spec.flags & GPBF_DATA_DESCRIPTOR) {
      const dd = new Uint8Array(16);
      const dv = new DataView(dd.buffer);
      dv.setUint32(0, 0x08074b50, true); // optional data-descriptor signature
      dv.setUint32(4, 0, true); // crc-32 (extractor ignores it)
      dv.setUint32(8, payload.byteLength, true);
      dv.setUint32(12, spec.content.byteLength, true);
      local.push(dd);
      recordSize += dd.byteLength;
    }

    const cdr = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(cdr.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, spec.flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, 0, true); // crc-32
    cv.setUint32(20, payload.byteLength, true); // compressed size (authoritative)
    cv.setUint32(24, spec.content.byteLength, true); // uncompressed size
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true); // local header offset
    cdr.set(name, 46);
    central.push(cdr);

    offset += recordSize;
  }

  const localBytes = concatBytes(local);
  const centralBytes = concatBytes(central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, specs.length, true); // records on this disk
  ev.setUint16(10, specs.length, true); // total records
  ev.setUint32(12, centralBytes.byteLength, true);
  ev.setUint32(16, localBytes.byteLength, true);
  return concatBytes([localBytes, centralBytes, eocd]);
}

describe("data descriptor (GPBF bit 3)", () => {
  test("extracts entries that stream their sizes in a trailing descriptor", async () => {
    const zip = makeRawZip([
      {
        name: "index.html",
        content: enc.encode("<!doctype html><title>dd</title><h1>Streamed</h1>"),
        flags: GPBF_DATA_DESCRIPTOR,
        deflate: true,
      },
      { name: "app.js", content: enc.encode("console.log('dd')"), flags: GPBF_DATA_DESCRIPTOR, deflate: true },
    ]);
    const files = await createZipExtractor().extract(zip);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["app.js", "index.html"]);
    const index = files.find((f) => f.path === "index.html");
    expect(new TextDecoder().decode(index!.data)).toContain("<h1>Streamed</h1>");
  });
});

describe("encrypted entry (GPBF bit 0)", () => {
  test("an entry flagged encrypted is rejected", async () => {
    const zip = makeRawZip([
      { name: "index.html", content: enc.encode("<title>x</title>"), flags: 0, deflate: false },
      { name: "secret.html", content: enc.encode("ciphertext"), flags: GPBF_ENCRYPTED, deflate: false },
    ]);
    await expectRejectCode(zip, "encrypted_entry");
  });
});
