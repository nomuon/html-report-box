import { expect, test } from "bun:test";
import { createElement, isValidElement } from "react";
import { App, PACKAGE_NAME } from "./index.ts";

test("@hrb/web exports package name and a renderable App element", () => {
  expect(PACKAGE_NAME).toBe("@hrb/web");
  expect(isValidElement(createElement(App))).toBe(true);
  expect(isValidElement(<App />)).toBe(true);
});
