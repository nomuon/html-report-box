import { useRef, useState } from "react";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { useToast } from "./Toast.tsx";

/** 共有 URL 行: readonly input + コピー ボタン（§4.3）. */
export function CopyUrlRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.push("success", "共有 URL をコピーしました");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      inputRef.current?.select();
      toast.push("danger", "コピーできませんでした。URL を選択してコピーしてください");
    }
  };

  return (
    <div className="hrb-copy-row">
      <input ref={inputRef} className="hrb-copy-row__input" readOnly value={url} aria-label="共有 URL" />
      <Button variant="secondary" onClick={copy} className={copied ? "hrb-copy-row__done" : ""}>
        {copied ? (
          <>
            <Icon name="check" size={16} /> コピーしました
          </>
        ) : (
          "コピー"
        )}
      </Button>
    </div>
  );
}

/** クリップボードコピーの共通処理（ヘッダーボタン等、トーストのみ版）. */
export function useCopyUrl() {
  const toast = useToast();
  return async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.push("success", "共有 URL をコピーしました");
    } catch {
      toast.push("danger", "コピーできませんでした。URL を選択してコピーしてください");
    }
  };
}
