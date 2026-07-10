/**
 * @hrb/shared — zod schemas, API contracts, tokenizer, constants.
 * Must remain portable (Node 22 compatible, no Bun-only APIs).
 */
export const PACKAGE_NAME = "@hrb/shared";

export * from "./constants.ts";
export * from "./tokenizer.ts";
export * from "./report.ts";
export * from "./api.ts";
