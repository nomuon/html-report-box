/**
 * Minimal ZIP central-directory parser. fflate's high-level Unzip API hides the
 * fields our security guards depend on — versionMadeBy / externalFileAttributes
 * (symlink detection), the general-purpose bit flag (encryption), and the exact
 * per-entry compressedSize (ratio guard) — so we parse the End Of Central
 * Directory record and each central-directory record ourselves. Only structure
 * is read here; decompression happens in extractor.ts. Portable (Node 22),
 * WinterCG-safe: Uint8Array + DataView only, no Buffer / Node streams.
 */
import { ZipValidationError } from "./errors.ts";

const EOCD_SIGNATURE = 0x06054b50; // "PK\05\06"
const CDR_SIGNATURE = 0x02014b50; // "PK\01\02"
const LFH_SIGNATURE = 0x04034b50; // "PK\03\04"
const EOCD_MIN_SIZE = 22;
const CDR_MIN_SIZE = 46;
const LFH_MIN_SIZE = 30;
const MAX_COMMENT = 0xffff;

const utf8 = new TextDecoder("utf-8", { fatal: false });

/** One central-directory record, carrying every field a guard needs. */
export interface CentralDirectoryEntry {
  fileName: string;
  /** General-purpose bit flag (bit 0 = encrypted, bit 3 = data descriptor). */
  generalPurposeBitFlag: number;
  compressionMethod: number;
  /** Declared compressed size (used only for the ratio guard denominator). */
  compressedSize: number;
  versionMadeBy: number;
  externalFileAttributes: number;
  /** Byte offset of this entry's local file header from the archive start. */
  localHeaderOffset: number;
}

/** Locate the EOCD by scanning backwards past any trailing archive comment. */
function findEocdOffset(data: Uint8Array): number {
  if (data.byteLength < EOCD_MIN_SIZE) {
    throw new ZipValidationError("invalid_zip", "archive smaller than a zip EOCD record");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const minStart = Math.max(0, data.byteLength - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let pos = data.byteLength - EOCD_MIN_SIZE; pos >= minStart; pos -= 1) {
    if (view.getUint32(pos, true) === EOCD_SIGNATURE) return pos;
  }
  throw new ZipValidationError("invalid_zip", "end of central directory record not found");
}

/**
 * Parse the central directory into records. Bounds are validated defensively;
 * any structural corruption surfaces as invalid_zip.
 */
export function parseCentralDirectory(data: Uint8Array): CentralDirectoryEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEocdOffset(data);
  const recordCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries: CentralDirectoryEntry[] = [];
  for (let i = 0; i < recordCount; i += 1) {
    if (offset + CDR_MIN_SIZE > data.byteLength || view.getUint32(offset, true) !== CDR_SIGNATURE) {
      throw new ZipValidationError("invalid_zip", "malformed central directory record");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + CDR_MIN_SIZE;
    if (nameStart + nameLength > data.byteLength) {
      throw new ZipValidationError("invalid_zip", "central directory record name out of bounds");
    }
    entries.push({
      fileName: utf8.decode(data.subarray(nameStart, nameStart + nameLength)),
      generalPurposeBitFlag: view.getUint16(offset + 8, true),
      compressionMethod: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      versionMadeBy: view.getUint16(offset + 4, true),
      externalFileAttributes: view.getUint32(offset + 38, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Resolve the byte offset of an entry's compressed payload. The local file
 * header's own name/extra lengths are authoritative here — they may differ from
 * the central directory's — so we re-read them from the local header.
 */
export function localDataOffset(data: Uint8Array, entry: CentralDirectoryEntry): number {
  const at = entry.localHeaderOffset;
  if (at + LFH_MIN_SIZE > data.byteLength) {
    throw new ZipValidationError("invalid_zip", "local file header out of bounds", entry.fileName);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(at, true) !== LFH_SIGNATURE) {
    throw new ZipValidationError("invalid_zip", "missing local file header signature", entry.fileName);
  }
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const dataStart = at + LFH_MIN_SIZE + nameLength + extraLength;
  if (dataStart + entry.compressedSize > data.byteLength) {
    throw new ZipValidationError("invalid_zip", "entry data out of bounds", entry.fileName);
  }
  return dataStart;
}
