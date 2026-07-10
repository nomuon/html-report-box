import { expect, test } from "bun:test";
import { DEPENDS_ON, PACKAGE_NAME } from "./index.ts";

test("@hrb/core stub resolves workspace dependency @hrb/shared", () => {
  expect(PACKAGE_NAME).toBe("@hrb/core");
  expect(DEPENDS_ON).toBe("@hrb/shared");
});
