/**
 * Tiny JSON file persistence for local dev adapters (.local-data/).
 * Local-only module — not shipped to Lambda.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore<T> {
  private data: T | undefined;

  constructor(
    private readonly filePath: string,
    private readonly initial: () => T,
  ) {}

  get(): T {
    if (this.data === undefined) {
      try {
        this.data = JSON.parse(readFileSync(this.filePath, "utf8")) as T;
      } catch {
        this.data = this.initial();
      }
    }
    return this.data;
  }

  save(): void {
    if (this.data === undefined) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.filePath);
  }

  mutate<R>(fn: (data: T) => R): R {
    const result = fn(this.get());
    this.save();
    return result;
  }
}
