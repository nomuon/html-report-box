/**
 * Local ObjectStorage — filesystem under `${dataDir}/objects/<key>`.
 * "Presigned uploads" become POSTs to the api dev server's /local-upload
 * route, which calls putStagingObject() with the returned key.
 * Local-only module.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { PresignedUpload } from "@hrb/shared";
import { DomainError } from "../errors.ts";
import type { ObjectStorage } from "../ports.ts";

export class LocalObjectStorage implements ObjectStorage {
  private readonly baseDir: string;

  constructor(
    dataDir: string,
    /** URL the dev client POSTs the file to (handled by @hrb/api local server). */
    private readonly uploadEndpoint: string = "/local-upload",
  ) {
    this.baseDir = resolve(dataDir, "objects");
  }

  private pathFor(key: string): string {
    if (key.startsWith("/") || key.includes("\\")) {
      throw new DomainError("bad_request", `invalid object key: ${key}`);
    }
    const path = resolve(this.baseDir, normalize(key));
    if (path !== this.baseDir && !path.startsWith(this.baseDir + sep)) {
      throw new DomainError("bad_request", `invalid object key: ${key}`);
    }
    return path;
  }

  async createPresignedUpload(opts: {
    key: string;
    maxSizeBytes: number;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload> {
    return {
      method: "post",
      url: this.uploadEndpoint,
      fields: { key: opts.key },
      headers: {},
      key: opts.key,
      expiresInSeconds: opts.expiresInSeconds ?? 900,
      maxSizeBytes: opts.maxSizeBytes,
    };
  }

  /** Dev-server hook backing the /local-upload route (not part of the port). */
  async putStagingObject(key: string, data: Uint8Array): Promise<void> {
    if (!key.startsWith("staging/")) {
      throw new DomainError("bad_request", "staging keys must start with staging/");
    }
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }

  async getStagingObject(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(readFileSync(this.pathFor(key)));
    } catch {
      return null;
    }
  }

  async deleteStagingObject(key: string): Promise<void> {
    rmSync(this.pathFor(key), { force: true });
  }

  async putContentObject(key: string, data: Uint8Array, _contentType: string): Promise<void> {
    // contentType is recomputed from the extension when the dev server serves /r/*.
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }

  async getContentObject(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(readFileSync(this.pathFor(key)));
    } catch {
      return null;
    }
  }

  async deleteContentObject(key: string): Promise<void> {
    rmSync(this.pathFor(key), { force: true });
  }

  async deleteContentPrefix(prefix: string): Promise<void> {
    // Prefixes are directory-shaped ("reports/<id>/").
    const path = this.pathFor(prefix.replace(/\/+$/, ""));
    rmSync(path, { recursive: true, force: true });
  }
}
