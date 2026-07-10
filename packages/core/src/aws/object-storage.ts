/**
 * S3ObjectStorage — ObjectStorage over the staging + content buckets.
 *
 * - Presigned POST against the staging bucket enforces the size cap via a
 *   `content-length-range` policy condition (min 1 byte, max per kind).
 * - Content objects (reports/<id>/..., including .extracted.txt) live in the
 *   content bucket, served through CloudFront Distribution B.
 * - The presign function is injectable so unit tests can capture the policy
 *   without real credentials.
 *
 * Portable (Node 22 / Lambda); no Bun-only APIs.
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import type { PresignedUpload } from "@hrb/shared";
import type { ObjectStorage } from "../ports.ts";
import { chunk } from "./dynamo-util.ts";
import type { CommandClient } from "./types.ts";

/** Max keys per DeleteObjects request (S3 API limit). */
export const DELETE_OBJECTS_CHUNK = 1000;
const DEFAULT_PRESIGN_EXPIRY_SECONDS = 900;

export interface PresignPostParams {
  Bucket: string;
  Key: string;
  /** Policy conditions; always includes ["content-length-range", 1, max]. */
  Conditions: Array<[string, ...Array<string | number>]>;
  Expires: number;
}

export type PresignPostFn = (
  params: PresignPostParams,
) => Promise<{ url: string; fields: Record<string, string> }>;

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NoSuchKey" || name === "NotFound") return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return status === 404;
}

async function bodyToBytes(body: unknown): Promise<Uint8Array | null> {
  if (body == null) return null;
  if (body instanceof Uint8Array) return body;
  const streaming = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof streaming.transformToByteArray === "function") {
    return streaming.transformToByteArray();
  }
  return null;
}

export interface S3ObjectStorageOptions {
  client: CommandClient;
  stagingBucket: string;
  contentBucket: string;
  /** Injectable for tests; defaults to @aws-sdk/s3-presigned-post on `client`. */
  presignPost?: PresignPostFn;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: CommandClient;
  private readonly stagingBucket: string;
  private readonly contentBucket: string;
  private readonly presignPost: PresignPostFn;

  constructor(options: S3ObjectStorageOptions) {
    this.client = options.client;
    this.stagingBucket = options.stagingBucket;
    this.contentBucket = options.contentBucket;
    this.presignPost =
      options.presignPost ??
      (async (params) => {
        const { url, fields } = await createPresignedPost(this.client as S3Client, {
          Bucket: params.Bucket,
          Key: params.Key,
          // Cast: the SDK's Conditions union is wider than our tuple type.
          Conditions: params.Conditions as unknown as Parameters<
            typeof createPresignedPost
          >[1]["Conditions"],
          Expires: params.Expires,
        });
        return { url, fields };
      });
  }

  async createPresignedUpload(opts: {
    key: string;
    maxSizeBytes: number;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload> {
    const expiresInSeconds = opts.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
    const { url, fields } = await this.presignPost({
      Bucket: this.stagingBucket,
      Key: opts.key,
      Conditions: [["content-length-range", 1, opts.maxSizeBytes]],
      Expires: expiresInSeconds,
    });
    return {
      url,
      fields,
      key: opts.key,
      expiresInSeconds,
      maxSizeBytes: opts.maxSizeBytes,
    };
  }

  async getStagingObject(key: string): Promise<Uint8Array | null> {
    return this.getObject(this.stagingBucket, key);
  }

  async deleteStagingObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.stagingBucket, Key: key }),
    );
  }

  async putContentObject(key: string, data: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.contentBucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
  }

  async getContentObject(key: string): Promise<Uint8Array | null> {
    return this.getObject(this.contentBucket, key);
  }

  async deleteContentPrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.contentBucket,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      const keys = ((res?.Contents ?? []) as Array<{ Key?: string }>)
        .map((obj) => obj.Key)
        .filter((key): key is string => typeof key === "string");
      for (const batch of chunk(keys, DELETE_OBJECTS_CHUNK)) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.contentBucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
      continuationToken = res?.NextContinuationToken as string | undefined;
    } while (continuationToken);
  }

  private async getObject(bucket: string, key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return await bodyToBytes(res?.Body);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}
