import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** destructive 確認中はオーバーレイクリックで閉じない */
  closeOnOverlay?: boolean;
}

export function Modal({ open, title, onClose, children, footer, closeOnOverlay = true }: ModalProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // 簡易フォーカストラップ: 開時に最初のフォーカス可能要素へ
    const el = bodyRef.current?.querySelector<HTMLElement>(
      "input, textarea, select, button, [tabindex]",
    );
    el?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="hrb-modal-overlay"
      onMouseDown={(e) => {
        if (closeOnOverlay && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="hrb-modal" role="dialog" aria-modal="true" aria-label={title} ref={bodyRef}>
        <div className="hrb-modal__header">
          <h2 className="hrb-modal__title">{title}</h2>
          <button type="button" className="hrb-icon-btn hrb-modal__close" aria-label="閉じる" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="hrb-modal__body">{children}</div>
        {footer && <div className="hrb-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
