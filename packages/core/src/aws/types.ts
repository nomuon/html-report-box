/**
 * Shared plumbing types for the AWS adapters.
 *
 * Every adapter talks to AWS through a structurally-typed `send(command)`
 * client so unit tests can inject a fake `send` and assert on `command.input`
 * without touching the network. Real SDK clients satisfy this shape.
 *
 * Portable (Node 22 / Lambda); no Bun-only APIs.
 */

/** Minimal structural client: real AWS SDK v3 clients are assignable. */
export interface CommandClient {
  // deno-lint-ignore no-explicit-any
  send: (command: any) => Promise<any>;
}
