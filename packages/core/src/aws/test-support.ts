/**
 * Test doubles for the AWS adapters: a FakeClient that records every command
 * (constructor name + input) and routes it to a programmable handler. No AWS
 * calls are ever made. Used only by *.test.ts files; not exported from the
 * package entrypoint.
 */
import type { CommandClient } from "./types.ts";

// deno-lint-ignore no-explicit-any
export type CommandInput = any;

export interface RecordedCall {
  name: string;
  input: CommandInput;
}

export class FakeClient implements CommandClient {
  readonly calls: RecordedCall[] = [];
  private readonly handlers = new Map<string, (input: CommandInput) => unknown>();

  /** Register a handler by command constructor name, e.g. "QueryCommand". */
  on(commandName: string, handler: (input: CommandInput) => unknown): this {
    this.handlers.set(commandName, handler);
    return this;
  }

  async send(command: CommandInput): Promise<CommandInput> {
    const name: string = command?.constructor?.name ?? "Unknown";
    this.calls.push({ name, input: command.input });
    const handler = this.handlers.get(name);
    return handler ? handler(command.input) : {};
  }

  /** Inputs of every recorded call of the given command, in order. */
  inputsOf(commandName: string): CommandInput[] {
    return this.calls.filter((c) => c.name === commandName).map((c) => c.input);
  }
}

/**
 * ステートフルな in-memory S3 フェイク。バケットごとに key→bytes を Map で保持し、
 * Put/Get/Delete/List/DeleteObjects を S3ObjectStorage が期待する形で応答する。
 * コール記録のみの FakeClient と異なり実際にバイト列を round-trip するので、
 * object-storage の共通契約スイートをオフラインで S3 アダプタに流せる。
 */
export class FakeS3Client implements CommandClient {
  /** bucket → key → bytes */
  private readonly buckets = new Map<string, Map<string, Uint8Array>>();

  private bucket(name: string): Map<string, Uint8Array> {
    let b = this.buckets.get(name);
    if (!b) this.buckets.set(name, (b = new Map()));
    return b;
  }

  /** presigned upload を経由しない staging 投入用の直接シード。 */
  put(bucket: string, key: string, data: Uint8Array): void {
    this.bucket(bucket).set(key, data);
  }

  async send(command: CommandInput): Promise<CommandInput> {
    const name: string = command?.constructor?.name ?? "Unknown";
    const input = command?.input ?? {};
    switch (name) {
      case "PutObjectCommand":
        this.bucket(input.Bucket).set(input.Key, input.Body as Uint8Array);
        return {};
      case "GetObjectCommand": {
        const data = this.bucket(input.Bucket).get(input.Key);
        if (data === undefined) throw namedError("NoSuchKey");
        return { Body: { transformToByteArray: async () => data } };
      }
      case "DeleteObjectCommand":
        this.bucket(input.Bucket).delete(input.Key);
        return {};
      case "ListObjectsV2Command": {
        const prefix: string = input.Prefix ?? "";
        const Contents = [...this.bucket(input.Bucket).keys()]
          .filter((key) => key.startsWith(prefix))
          .map((Key) => ({ Key }));
        return { Contents };
      }
      case "DeleteObjectsCommand": {
        const b = this.bucket(input.Bucket);
        for (const { Key } of input.Delete?.Objects ?? []) b.delete(Key);
        return {};
      }
      default:
        return {};
    }
  }
}

export function conditionalCheckFailed(): Error {
  return Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
  });
}

export function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}
