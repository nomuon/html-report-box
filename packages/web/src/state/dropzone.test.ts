import { describe, expect, test } from "bun:test";
import type { OwnedReport } from "@hrb/shared";
import {
  DROPZONE_INITIAL,
  MSG_BAD_EXTENSION,
  MSG_MULTIPLE_FILES,
  MSG_TOO_LARGE,
  dropzoneReducer,
  kindForFilename,
  validateFiles,
} from "./dropzone.ts";
import type { DropzoneEvent, DropzoneState, SelectedFile } from "./dropzone.ts";

const file: SelectedFile = { name: "report.html", size: 1234, kind: "html" };

function report(status: OwnedReport["status"], findings: OwnedReport["findings"] = []): OwnedReport {
  return {
    id: "A".repeat(21),
    title: "t",
    description: "",
    ownerSub: "dev-alice",
    ownerName: "Alice",
    status,
    kind: "html",
    version: 1,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    findings,
    versions: [],
  };
}

function run(events: DropzoneEvent[], from: DropzoneState = DROPZONE_INITIAL): DropzoneState {
  return events.reduce(dropzoneReducer, from);
}

describe("dropzoneReducer", () => {
  test("happy path: idle → dragover → selected → uploading → scanning → done", () => {
    let s = run([{ type: "DRAG_ENTER" }]);
    expect(s.phase).toBe("dragover");
    s = run([{ type: "FILE_ACCEPTED", file }], s);
    expect(s.phase).toBe("selected");
    s = run([{ type: "UPLOAD_START" }], s);
    expect(s).toEqual({ phase: "uploading", file, percent: 0 });
    s = run([{ type: "PROGRESS", percent: 55 }], s);
    expect(s).toEqual({ phase: "uploading", file, percent: 55 });
    s = run([{ type: "UPLOADED" }], s);
    expect(s).toEqual({ phase: "scanning", file });
    const done = run([{ type: "COMPLETE", report: report("published"), url: "http://x/r/a/" }], s);
    expect(done.phase).toBe("done");
    if (done.phase === "done") expect(done.url).toBe("http://x/r/a/");
  });

  test("dragleave returns to idle; dragenter is ignored mid-upload", () => {
    expect(run([{ type: "DRAG_ENTER" }, { type: "DRAG_LEAVE" }]).phase).toBe("idle");
    const uploading: DropzoneState = { phase: "uploading", file, percent: 10 };
    expect(run([{ type: "DRAG_ENTER" }], uploading)).toEqual(uploading);
  });

  test("非公開のまま完了（url なし）でも done に遷移する", () => {
    const s = run([{ type: "COMPLETE", report: report("private") }], {
      phase: "scanning",
      file,
    });
    expect(s.phase).toBe("done");
    if (s.phase === "done") expect(s.report.status).toBe("private");
  });

  test("verdict=block (rejected) lands on rejected with findings", () => {
    const findings = [{ ruleId: "r1", severity: "block" as const, message: "危険な内容" }];
    const s = run([{ type: "COMPLETE", report: report("rejected", findings) }], {
      phase: "scanning",
      file,
    });
    expect(s).toEqual({ phase: "rejected", findings });
  });

  test("CANCEL_UPLOAD returns uploading to selected (file kept); ignored elsewhere", () => {
    const s = run([{ type: "CANCEL_UPLOAD" }], { phase: "uploading", file, percent: 40 });
    expect(s).toEqual({ phase: "selected", file });
    // scanning 以降（complete 呼び出し後）はキャンセル不可
    const scanning: DropzoneState = { phase: "scanning", file };
    expect(run([{ type: "CANCEL_UPLOAD" }], scanning)).toEqual(scanning);
    expect(run([{ type: "CANCEL_UPLOAD" }])).toEqual(DROPZONE_INITIAL);
  });

  test("FAIL during upload/scanning returns to idle; RESET always resets", () => {
    expect(run([{ type: "FAIL" }], { phase: "uploading", file, percent: 4 }).phase).toBe("idle");
    expect(run([{ type: "FAIL" }], { phase: "scanning", file }).phase).toBe("idle");
    expect(run([{ type: "RESET" }], { phase: "rejected", findings: [] }).phase).toBe("idle");
  });

  test("guards: PROGRESS/UPLOADED/COMPLETE are ignored outside their phases", () => {
    expect(run([{ type: "PROGRESS", percent: 50 }])).toEqual(DROPZONE_INITIAL);
    expect(run([{ type: "UPLOADED" }])).toEqual(DROPZONE_INITIAL);
    expect(run([{ type: "COMPLETE", report: report("published") }])).toEqual(DROPZONE_INITIAL);
    expect(run([{ type: "UPLOAD_START" }])).toEqual(DROPZONE_INITIAL);
  });

  test("PROGRESS clamps percent to 0-100", () => {
    const uploading: DropzoneState = { phase: "uploading", file, percent: 0 };
    const over = run([{ type: "PROGRESS", percent: 150 }], uploading);
    if (over.phase === "uploading") expect(over.percent).toBe(100);
    const under = run([{ type: "PROGRESS", percent: -5 }], uploading);
    if (under.phase === "uploading") expect(under.percent).toBe(0);
  });

  test("a new drop replaces a previously selected file", () => {
    const other: SelectedFile = { name: "b.zip", size: 99, kind: "zip" };
    const s = run([{ type: "FILE_ACCEPTED", file: other }], { phase: "selected", file });
    expect(s).toEqual({ phase: "selected", file: other });
  });
});

const limits = { maxHtmlSizeBytes: 5 * 1024 * 1024, maxZipSizeBytes: 20 * 1024 * 1024 };

describe("validateFiles", () => {
  test("accepts .html/.htm/.zip (case-insensitive) and infers kind", () => {
    expect(kindForFilename("A.HTML")).toBe("html");
    expect(kindForFilename("a.htm")).toBe("html");
    expect(kindForFilename("a.ZIP")).toBe("zip");
    expect(kindForFilename("a.pdf")).toBeNull();
    const ok = validateFiles([{ name: "r.html", size: 100 }], limits);
    expect(ok).toEqual({ ok: true, file: { name: "r.html", size: 100, kind: "html" } });
  });

  test("rejects multiple files", () => {
    const res = validateFiles(
      [
        { name: "a.html", size: 1 },
        { name: "b.html", size: 1 },
      ],
      limits,
    );
    expect(res).toEqual({ ok: false, message: MSG_MULTIPLE_FILES });
  });

  test("rejects unsupported extensions", () => {
    expect(validateFiles([{ name: "a.exe", size: 1 }], limits)).toEqual({
      ok: false,
      message: MSG_BAD_EXTENSION,
    });
    expect(validateFiles([], limits)).toEqual({ ok: false, message: MSG_BAD_EXTENSION });
  });

  test("enforces per-kind size limits (HTML 5MB / ZIP 20MB)", () => {
    expect(validateFiles([{ name: "a.html", size: limits.maxHtmlSizeBytes + 1 }], limits)).toEqual({
      ok: false,
      message: MSG_TOO_LARGE,
    });
    expect(
      validateFiles([{ name: "a.zip", size: limits.maxHtmlSizeBytes + 1 }], limits).ok,
    ).toBe(true);
    expect(validateFiles([{ name: "a.zip", size: limits.maxZipSizeBytes + 1 }], limits)).toEqual({
      ok: false,
      message: MSG_TOO_LARGE,
    });
  });
});
