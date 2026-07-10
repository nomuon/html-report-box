import { expect, test } from "bun:test";
import { PACKAGE_NAME } from "./index.ts";

test("@hrb/shared stub exports package name", () => {
  expect(PACKAGE_NAME).toBe("@hrb/shared");
});
