/**
 * ZipExtractor port implementation (fflate streaming). Every limit is
 * enforced on MEASURED output — declared sizes in zip headers are never
 * trusted. Guards: zip-slip (../ , absolute paths, backslash tricks),
 * symlinks, encrypted entries, zip bombs (total size / entry count /
 * per-entry compression ratio), nested zips (extension AND content sniff),
 * extension allowlist, mandatory root index.html. Portable (Node 22),
 * WinterCG-safe: no Buffer, no Node streams — Uint8Array + DataView only.
 */
import { Inflate } from "fflate";
import { isAllowedZipEntryExtension } from "@hrb/shared";
import type { ZipEntryFile, ZipExtractor } from "@hrb/core";
import { resolveConfig, type ResolvedScannerConfig, type ScannerConfig } from "../config.ts";
import { pathExtension } from "../url.ts";
import {
  localDataOffset,
  parseCentralDirectory,
  type CentralDirectoryEntry,
} from "./central-directory.ts";
import { ZipValidationError } from "./errors.ts";

const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
const OS_UNIX = 3;
const GPBF_ENCRYPTED = 0x0001;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** Push compressed input in slices so a bomb aborts before it fully inflates. */
const INFLATE_SLICE_BYTES = 64 * 1024;

/** Sentinel thrown from the inflate callback the moment the size cap is hit. */
const OVERFLOW = Symbol("zip-size-overflow");

function isSymlinkEntry(entry: CentralDirectoryEntry): boolean {
  const madeByOs = (entry.versionMadeBy >> 8) & 0xff;
  if (madeByOs !== OS_UNIX) return false;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & S_IFMT) === S_IFLNK;
}

function isEncryptedEntry(entry: CentralDirectoryEntry): boolean {
  return (entry.generalPurposeBitFlag & GPBF_ENCRYPTED) !== 0;
}

function isZipMagic(data: Uint8Array): boolean {
  return (
    data.byteLength >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    ((data[2] === 0x03 && data[3] === 0x04) || (data[2] === 0x05 && data[3] === 0x06))
  );
}

/**
 * Normalize and validate an entry path. Rejects absolute paths, ".."/"."/empty
 * segments, backslash traversal tricks, and control characters — defense in
 * depth so a hostile central-directory name can never escape the extract root.
 */
function normalizeEntryPath(rawName: string): string {
  const path = rawName.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new ZipValidationError("zip_slip", `absolute entry path: ${rawName}`, rawName);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new ZipValidationError("zip_slip", "control characters in entry path", rawName);
  }
  const isDirectory = path.endsWith("/");
  const segments = (isDirectory ? path.slice(0, -1) : path).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ZipValidationError("zip_slip", `unsafe entry path: ${rawName}`, rawName);
    }
  }
  return path;
}

/**
 * Inflate an entry's compressed payload while counting output bytes; abort as
 * soon as maxBytes is exceeded so a zip bomb is never fully materialized.
 */
function inflateEntryCapped(
  compressed: Uint8Array,
  method: number,
  maxBytes: number,
  path: string,
): Uint8Array {
  if (method === METHOD_STORED) {
    if (compressed.byteLength > maxBytes) {
      throw new ZipValidationError(
        "zip_bomb_size",
        "measured uncompressed size exceeds the archive limit",
        path,
      );
    }
    return compressed.slice();
  }
  if (method !== METHOD_DEFLATE) {
    throw new ZipValidationError("invalid_zip", `unsupported compression method: ${method}`, path);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const inflate = new Inflate((chunk) => {
    size += chunk.byteLength;
    if (size > maxBytes) throw OVERFLOW;
    chunks.push(chunk);
  });

  try {
    let offset = 0;
    do {
      const end = Math.min(offset + INFLATE_SLICE_BYTES, compressed.byteLength);
      inflate.push(compressed.subarray(offset, end), end >= compressed.byteLength);
      offset = end;
    } while (offset < compressed.byteLength);
  } catch (err) {
    if (err === OVERFLOW) {
      throw new ZipValidationError(
        "zip_bomb_size",
        "measured uncompressed size exceeds the archive limit",
        path,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ZipValidationError("invalid_zip", `entry read failed: ${message}`, path);
  }

  const out = new Uint8Array(size);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return out;
}

export function createZipExtractor(config?: ScannerConfig): ZipExtractor {
  const cfg: ResolvedScannerConfig = resolveConfig(config);

  return {
    async extract(data: Uint8Array): Promise<ZipEntryFile[]> {
      // No async work remains, but the port contract is Promise-based.
      const entries = parseCentralDirectory(data);

      const files: ZipEntryFile[] = [];
      let entryCount = 0;
      let totalBytes = 0;

      for (const entry of entries) {
        entryCount += 1;
        if (entryCount > cfg.maxZipEntries) {
          throw new ZipValidationError(
            "zip_bomb_entries",
            `archive exceeds ${cfg.maxZipEntries} entries`,
          );
        }
        const path = normalizeEntryPath(entry.fileName);
        if (isSymlinkEntry(entry)) {
          throw new ZipValidationError("symlink_entry", `symbolic link entry: ${path}`, path);
        }
        if (isEncryptedEntry(entry)) {
          throw new ZipValidationError("encrypted_entry", `encrypted entry: ${path}`, path);
        }
        if (path.endsWith("/")) continue; // directory entry (path already validated)

        const ext = pathExtension(path);
        if (ext === ".zip") {
          throw new ZipValidationError("nested_zip", `nested zip archive: ${path}`, path);
        }
        if (!isAllowedZipEntryExtension(ext)) {
          throw new ZipValidationError(
            "disallowed_extension",
            `entry extension not allowed: ${path}`,
            path,
          );
        }

        const dataStart = localDataOffset(data, entry);
        const compressed = data.subarray(dataStart, dataStart + entry.compressedSize);
        const entryData = inflateEntryCapped(
          compressed,
          entry.compressionMethod,
          cfg.maxZipUncompressedBytes - totalBytes,
          path,
        );
        totalBytes += entryData.byteLength;

        if (isZipMagic(entryData)) {
          throw new ZipValidationError("nested_zip", `entry content is a zip archive: ${path}`, path);
        }
        if (
          entryData.byteLength > cfg.minRatioCheckBytes &&
          entry.compressedSize > 0 &&
          entryData.byteLength / entry.compressedSize > cfg.maxZipCompressionRatio
        ) {
          throw new ZipValidationError(
            "zip_bomb_ratio",
            `measured compression ratio exceeds ${cfg.maxZipCompressionRatio}:1`,
            path,
          );
        }

        files.push({ path, data: entryData });
      }

      if (!files.some((file) => file.path === "index.html")) {
        throw new ZipValidationError("missing_root_index", "zip must contain a root index.html");
      }
      return files;
    },
  };
}
