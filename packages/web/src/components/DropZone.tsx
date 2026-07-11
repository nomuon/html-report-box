/**
 * DropZone — 見た目とドラッグ&ドロップ入力だけを担う。状態遷移は親が
 * dropzoneReducer で管理し、state と dispatch を渡す（DOM 依存を薄く保つ）。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { ProgressBar } from "./ProgressBar.tsx";
import { formatBytes } from "../lib/format.ts";
import type { DropzoneEvent, DropzoneState } from "../state/dropzone.ts";

export interface DropZoneProps {
  state: DropzoneState;
  dispatch: (ev: DropzoneEvent) => void;
  /** drop / browse で選ばれたファイル。親が検証して FILE_ACCEPTED を発火する。 */
  onFiles: (files: File[]) => void;
  onCancelUpload?: () => void;
  /** done / rejected / warn 表示は画面ごとに異なるため親が差し込む。 */
  resultContent?: ReactNode;
  small?: boolean;
}

const SCAN_SLOW_MS = 3000;

export function DropZone({ state, dispatch, onFiles, onCancelUpload, resultContent, small }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // dragleave の児要素チラつき対策: カウンタ方式
  const dragDepth = useRef(0);
  const [scanSlow, setScanSlow] = useState(false);

  useEffect(() => {
    if (state.phase !== "scanning") {
      setScanSlow(false);
      return;
    }
    const t = setTimeout(() => setScanSlow(true), SCAN_SLOW_MS);
    return () => clearTimeout(t);
  }, [state.phase]);

  // ページ全体への drop 事故防止
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const openPicker = () => inputRef.current?.click();
  const interactive =
    state.phase === "idle" || state.phase === "dragover" || state.phase === "selected";

  const classes = [
    "hrb-dropzone",
    `hrb-dropzone--${state.phase}`,
    small ? "hrb-dropzone--small" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label="ファイルをドラッグ＆ドロップ、または Enter でファイルを選択"
      onKeyDown={(e) => {
        if (interactive && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          openPicker();
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        if (!interactive) return;
        dragDepth.current += 1;
        dispatch({ type: "DRAG_ENTER" });
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        if (!interactive) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) dispatch({ type: "DRAG_LEAVE" });
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        if (!interactive) return;
        dispatch({ type: "DRAG_LEAVE" });
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".html,.htm,.zip"
        hidden
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      {state.phase === "idle" && (
        <div className="hrb-dropzone__inner">
          <div className="hrb-dropzone__icon" aria-hidden="true">
            <Icon name="upload-cloud" size={28} />
          </div>
          <p className="hrb-dropzone__lead">ここに HTML / ZIP ファイルをドラッグ＆ドロップ</p>
          <p className="hrb-dropzone__or">または</p>
          <Button variant="secondary" size="lg" onClick={openPicker}>
            ファイルを選択
          </Button>
        </div>
      )}

      {state.phase === "dragover" && (
        <div className="hrb-dropzone__inner">
          <div className="hrb-dropzone__icon" aria-hidden="true">
            <Icon name="file-drop" size={28} />
          </div>
          <p className="hrb-dropzone__lead">ドロップしてアップロード</p>
        </div>
      )}

      {state.phase === "selected" && (
        <div className="hrb-dropzone__inner">
          <div className="hrb-dropzone__icon" aria-hidden="true">
            <Icon name="file" size={28} />
          </div>
          <p className="hrb-dropzone__lead">{state.file.name}</p>
          <p className="hrb-dropzone__note">
            {formatBytes(state.file.size)} · {state.file.kind === "html" ? "HTML" : "ZIP"}
          </p>
          <Button variant="ghost" onClick={openPicker}>
            別のファイルを選ぶ
          </Button>
        </div>
      )}

      {state.phase === "uploading" && (
        <div className="hrb-dropzone__inner hrb-dropzone__inner--wide">
          <p className="hrb-dropzone__lead">{state.file.name}</p>
          <p className="hrb-dropzone__note">{formatBytes(state.file.size)}</p>
          <ProgressBar percent={state.percent} />
          {onCancelUpload && (
            <Button variant="ghost" onClick={onCancelUpload}>
              キャンセル
            </Button>
          )}
        </div>
      )}

      {state.phase === "scanning" && (
        <div className="hrb-dropzone__inner hrb-dropzone__inner--wide">
          <div className="hrb-dropzone__icon hrb-dropzone__icon--accent" aria-hidden="true">
            <Icon name="shield-check" size={28} />
          </div>
          <p className="hrb-dropzone__lead hrb-dropzone__lead--muted">セキュリティスキャン中…</p>
          <ProgressBar />
          {scanSlow && (
            <p className="hrb-dropzone__note">大きなファイルは時間がかかることがあります</p>
          )}
        </div>
      )}

      {(state.phase === "done" || state.phase === "rejected") && (
        <div className="hrb-dropzone__inner hrb-dropzone__inner--wide">{resultContent}</div>
      )}
    </div>
  );
}
