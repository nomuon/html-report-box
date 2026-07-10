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

export function conditionalCheckFailed(): Error {
  return Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
  });
}

export function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}
