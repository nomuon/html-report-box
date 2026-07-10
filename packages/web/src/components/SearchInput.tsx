import { useEffect, useState } from "react";

export interface SearchInputProps {
  initialValue?: string;
  onSearch: (q: string) => void;
  placeholder?: string;
}

export function SearchInput({ initialValue = "", onSearch, placeholder = "レポートを検索…" }: SearchInputProps) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);

  return (
    <div className="hrb-search">
      <span className="hrb-search__icon" aria-hidden="true">
        🔍
      </span>
      <input
        type="search"
        className="hrb-search__input"
        value={value}
        placeholder={placeholder}
        aria-label="レポートを検索"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // IME 変換確定の Enter では検索しない
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            const q = value.trim();
            if (q) onSearch(q);
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="hrb-search__clear"
          aria-label="クリア"
          onClick={() => setValue("")}
        >
          ✕
        </button>
      )}
    </div>
  );
}
