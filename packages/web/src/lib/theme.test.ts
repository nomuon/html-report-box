import { describe, expect, test } from "bun:test";
import { nextPreference, parseStoredPreference, resolveTheme } from "./theme.ts";

describe("parseStoredPreference", () => {
  test("accepts system / light / dark", () => {
    expect(parseStoredPreference("system")).toBe("system");
    expect(parseStoredPreference("light")).toBe("light");
    expect(parseStoredPreference("dark")).toBe("dark");
  });

  test("rejects unknown or missing values", () => {
    expect(parseStoredPreference(null)).toBeNull();
    expect(parseStoredPreference("")).toBeNull();
    expect(parseStoredPreference("auto")).toBeNull();
  });
});

describe("resolveTheme", () => {
  test("system follows the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  test("explicit choice wins over the OS preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("nextPreference", () => {
  test("cycles system → light → dark → system", () => {
    expect(nextPreference("system")).toBe("light");
    expect(nextPreference("light")).toBe("dark");
    expect(nextPreference("dark")).toBe("system");
  });
});
