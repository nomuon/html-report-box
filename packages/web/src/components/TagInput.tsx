/**
 * タグのチップ入力。カンマ or Enter で確定し、チップの × で削除する。
 * 正規化（trim・空除外・重複除去・上限）はサーバーと同じルールをクライアント側でも適用する。
 */
import { useState } from "react";
import { REPORT_TAG_MAX, REPORT_TAGS_MAX } from "@hrb/shared";
import { Icon } from "./Icon.tsx";

export function TagInput({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  /** カンマ区切りの入力をタグとして確定する（不正・重複・超過分は捨てる）。 */
  const commit = (raw: string) => {
    const next = [...tags];
    for (const part of raw.split(",")) {
      const tag = part.trim();
      if (tag.length === 0 || tag.length > REPORT_TAG_MAX || next.includes(tag)) continue;
      if (next.length >= REPORT_TAGS_MAX) break;
      next.push(tag);
    }
    if (next.length !== tags.length) onChange(next);
    setDraft("");
  };

  const remove = (tag: string) => onChange(tags.filter((t) => t !== tag));

  return (
    <div className="hrb-tag-input">
      {tags.map((tag) => (
        <span key={tag} className="hrb-chip hrb-chip--tag">
          {tag}
          <button
            type="button"
            className="hrb-tag-input__remove"
            aria-label={`タグ「${tag}」を削除`}
            onClick={() => remove(tag)}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <input
        className="hrb-tag-input__field"
        value={draft}
        maxLength={REPORT_TAG_MAX + 1}
        placeholder={
          tags.length >= REPORT_TAGS_MAX
            ? `タグは最大${REPORT_TAGS_MAX}個までです`
            : "カンマ or Enter で追加"
        }
        disabled={tags.length >= REPORT_TAGS_MAX}
        aria-label="タグを追加"
        onChange={(e) => {
          // カンマ入力で即確定（IME 変換中はカンマが入らないので安全）
          if (e.target.value.includes(",")) commit(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
            remove(tags[tags.length - 1]!);
          }
        }}
        onBlur={() => {
          if (draft.trim()) commit(draft);
        }}
      />
    </div>
  );
}
