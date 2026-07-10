import { describe, expect, test } from "bun:test";
import { formatBytes, formatDateTime } from "./format.ts";

describe("formatDateTime", () => {
  test("renders YYYY/MM/DD HH:mm in local time", () => {
    const d = new Date(2026, 6, 10, 21, 30); // local 2026-07-10 21:30
    expect(formatDateTime(d.toISOString())).toBe("2026/07/10 21:30");
  });

  test("zero-pads month/day/hour/minute", () => {
    const d = new Date(2026, 0, 5, 9, 5);
    expect(formatDateTime(d.toISOString())).toBe("2026/01/05 09:05");
  });

  test("invalid input falls back to the raw string", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });
});

describe("formatBytes", () => {
  test("formats each magnitude", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1234567)).toBe("1.2 MB");
    expect(formatBytes(-1)).toBe("-");
  });
});
