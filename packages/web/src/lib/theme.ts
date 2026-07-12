/**
 * Theme handling: preference is "system" | "light" | "dark", persisted to
 * localStorage.hrb-theme. Explicit light/dark sets <html data-theme="...">;
 * "system" removes the attribute so the CSS prefers-color-scheme media query
 * follows the OS (watchSystemTheme lets JS react to OS changes too).
 * Pure helpers are DOM-free for testing; the DOM side touches document/matchMedia.
 */

export type Theme = "light" | "dark";
export type ThemePreference = "system" | Theme;
export const THEME_STORAGE_KEY = "hrb-theme";

export function parseStoredPreference(value: string | null): ThemePreference | null {
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

/** Effective theme = explicit choice if present, else OS preference. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): Theme {
  return preference === "system" ? (prefersDark ? "dark" : "light") : preference;
}

/** Toggle cycle: system → light → dark → system */
export function nextPreference(current: ThemePreference): ThemePreference {
  return current === "system" ? "light" : current === "light" ? "dark" : "system";
}

// ---- DOM side (browser only) ----

export function getThemePreference(): ThemePreference {
  const stored = parseStoredPreference(
    typeof localStorage !== "undefined" ? localStorage.getItem(THEME_STORAGE_KEY) : null,
  );
  return stored ?? "system";
}

export function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyThemePreference(preference: ThemePreference): void {
  if (preference === "system") {
    // 属性を外すと CSS のメディアクエリがそのまま OS 設定に追従する
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", preference);
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // storage unavailable — keep in-DOM state only
  }
}

/** OS テーマ変化を監視する（system 追従時の即時反映用）。解除関数を返す。 */
export function watchSystemTheme(onChange: (prefersDark: boolean) => void): () => void {
  if (typeof matchMedia === "undefined") return () => {};
  const mql = matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent) => onChange(e.matches);
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}
