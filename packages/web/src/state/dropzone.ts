/**
 * DropZone state machine (pure reducer — unit tested without DOM).
 *
 * Visual states (DESIGN.md §4.1):
 *   idle → dragover → (drop) → selected(メタ入力) → uploading(%) →
 *   scanning → done | rejected      (verdict=warn → done with 承認待ち表示)
 */
import type { OwnedReport, ReportKind, ScanFinding } from "@hrb/shared";

export interface SelectedFile {
  name: string;
  size: number;
  kind: ReportKind;
}

export type DropzoneState =
  | { phase: "idle" }
  | { phase: "dragover" }
  | { phase: "selected"; file: SelectedFile }
  | { phase: "uploading"; file: SelectedFile; percent: number }
  | { phase: "scanning"; file: SelectedFile }
  | { phase: "done"; report: OwnedReport; url?: string }
  | { phase: "rejected"; findings: ScanFinding[] };

export type DropzoneEvent =
  | { type: "DRAG_ENTER" }
  | { type: "DRAG_LEAVE" }
  | { type: "FILE_ACCEPTED"; file: SelectedFile }
  | { type: "CANCEL_SELECT" }
  | { type: "UPLOAD_START" }
  | { type: "PROGRESS"; percent: number }
  | { type: "UPLOADED" }
  | { type: "COMPLETE"; report: OwnedReport; url?: string }
  | { type: "FAIL" }
  | { type: "RESET" };

export const DROPZONE_INITIAL: DropzoneState = { phase: "idle" };

export function dropzoneReducer(state: DropzoneState, ev: DropzoneEvent): DropzoneState {
  switch (ev.type) {
    case "DRAG_ENTER":
      // Only meaningful before an upload is in flight.
      if (state.phase === "idle" || state.phase === "dragover") return { phase: "dragover" };
      return state;
    case "DRAG_LEAVE":
      return state.phase === "dragover" ? { phase: "idle" } : state;
    case "FILE_ACCEPTED":
      // A new drop replaces a previously selected file.
      if (state.phase === "idle" || state.phase === "dragover" || state.phase === "selected") {
        return { phase: "selected", file: ev.file };
      }
      return state;
    case "CANCEL_SELECT":
      return state.phase === "selected" ? { phase: "idle" } : state;
    case "UPLOAD_START":
      return state.phase === "selected"
        ? { phase: "uploading", file: state.file, percent: 0 }
        : state;
    case "PROGRESS":
      return state.phase === "uploading"
        ? { ...state, percent: Math.max(0, Math.min(100, ev.percent)) }
        : state;
    case "UPLOADED":
      return state.phase === "uploading" ? { phase: "scanning", file: state.file } : state;
    case "COMPLETE": {
      if (state.phase !== "scanning") return state;
      if (ev.report.status === "rejected") {
        return { phase: "rejected", findings: ev.report.findings };
      }
      // published (pass) と pending_review (warn) はどちらも done 表示
      // （warn は done コンポーネント側で承認待ち文言に切り替える）。
      return ev.url !== undefined
        ? { phase: "done", report: ev.report, url: ev.url }
        : { phase: "done", report: ev.report };
    }
    case "FAIL":
      // Network / API failure mid-flight: toast is shown by the caller.
      return state.phase === "uploading" || state.phase === "scanning"
        ? { phase: "idle" }
        : state;
    case "RESET":
      return { phase: "idle" };
  }
}

// ---- client-side pre-validation (§4.1 microcopy) ----

export interface UploadLimits {
  maxHtmlSizeBytes: number;
  maxZipSizeBytes: number;
}

export type FileValidation =
  | { ok: true; file: SelectedFile }
  | { ok: false; message: string };

export const MSG_MULTIPLE_FILES = "一度にアップロードできるのは 1 ファイルです";
export const MSG_BAD_EXTENSION = "HTML または ZIP ファイルのみアップロードできます";
export const MSG_TOO_LARGE = "ファイルサイズが上限（HTML 5MB / ZIP 20MB）を超えています";

export function kindForFilename(name: string): ReportKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".zip")) return "zip";
  return null;
}

export function validateFiles(
  files: ReadonlyArray<{ name: string; size: number }>,
  limits: UploadLimits,
): FileValidation {
  if (files.length === 0) return { ok: false, message: MSG_BAD_EXTENSION };
  if (files.length > 1) return { ok: false, message: MSG_MULTIPLE_FILES };
  const f = files[0]!;
  const kind = kindForFilename(f.name);
  if (!kind) return { ok: false, message: MSG_BAD_EXTENSION };
  const max = kind === "html" ? limits.maxHtmlSizeBytes : limits.maxZipSizeBytes;
  if (f.size > max) return { ok: false, message: MSG_TOO_LARGE };
  return { ok: true, file: { name: f.name, size: f.size, kind } };
}
