/**
 * ZipExtractor port implementation (yauzl, streaming). Every limit is
 * enforced on MEASURED output — declared sizes in zip headers are never
 * trusted. Guards: zip-slip (../ , absolute paths, backslash tricks),
 * symlinks, encrypted entries, zip bombs (total size / entry count /
 * per-entry compression ratio), nested zips (extension AND content sniff),
 * extension allowlist, mandatory root index.html. Portable (Node 22).
 */
import { Buffer } from "node:buffer";
import { fromBufferPromise, type Entry, type ZipFile } from "yauzl";
import { isAllowedZipEntryExtension } from "@hrb/shared";
import type { ZipEntryFile, ZipExtractor } from "@hrb/core";
import { resolveConfig, type ResolvedScannerConfig, type ScannerConfig } from "../config.ts";
import { pathExtension } from "../url.ts";
import { ZipValidationError } from "./errors.ts";

const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
const OS_UNIX = 3;

function isSymlinkEntry(entry: Entry): boolean {
  const madeByOs = (entry.versionMadeBy >> 8) & 0xff;
  if (madeByOs !== OS_UNIX) return false;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & S_IFMT) === S_IFLNK;
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
 * Normalize and validate an entry path. yauzl (decodeStrings) already rejects
 * absolute paths / ".." — this re-validates as defense in depth and rejects
 * what yauzl tolerates ("." segments, empty segments, control characters).
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

/** yauzl's decodeStrings validation errors are zip-slip attempts. */
function mapIterationError(err: unknown): ZipValidationError {
  if (err instanceof ZipValidationError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/absolute path|invalid relative path|invalid characters|file name/i.test(message)) {
    return new ZipValidationError("zip_slip", `unsafe entry path: ${message}`);
  }
  return new ZipValidationError("invalid_zip", `invalid zip archive: ${message}`);
}

/** Inflate an entry while counting bytes; abort as soon as maxBytes is hit. */
function readEntryCapped(
  zipfile: ZipFile,
  entry: Entry,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(new ZipValidationError("invalid_zip", `cannot read entry: ${path}`, path));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const fail = (error: ZipValidationError): void => {
        if (settled) return;
        settled = true;
        stream.destroy();
        reject(error);
      };
      stream.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          fail(
            new ZipValidationError(
              "zip_bomb_size",
              "measured uncompressed size exceeds the archive limit",
              path,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", (streamErr: Error) => {
        fail(new ZipValidationError("invalid_zip", `entry read failed: ${streamErr.message}`, path));
      });
      stream.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
    });
  });
}

export function createZipExtractor(config?: ScannerConfig): ZipExtractor {
  const cfg: ResolvedScannerConfig = resolveConfig(config);

  return {
    async extract(data: Uint8Array): Promise<ZipEntryFile[]> {
      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      let zipfile: ZipFile;
      try {
        zipfile = await fromBufferPromise(buffer, { lazyEntries: true });
      } catch (err) {
        throw mapIterationError(err);
      }

      const files: ZipEntryFile[] = [];
      let entryCount = 0;
      let totalBytes = 0;

      try {
        for await (const entry of zipfile.eachEntry()) {
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
          if (entry.isEncrypted()) {
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

          const entryData = await readEntryCapped(
            zipfile,
            entry,
            path,
            cfg.maxZipUncompressedBytes - totalBytes,
          );
          totalBytes += entryData.byteLength;

          if (isZipMagic(entryData)) {
            throw new ZipValidationError(
              "nested_zip",
              `entry content is a zip archive: ${path}`,
              path,
            );
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

          files.push({ path, data: new Uint8Array(entryData) });
        }
      } catch (err) {
        throw mapIterationError(err);
      } finally {
        zipfile.close();
      }

      if (!files.some((file) => file.path === "index.html")) {
        throw new ZipValidationError(
          "missing_root_index",
          "zip must contain a root index.html",
        );
      }
      return files;
    },
  };
}
