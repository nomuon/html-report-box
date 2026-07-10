/**
 * Theme handling: initial value follows prefers-color-scheme; a manual toggle
 * sets <html data-theme="light|dark"> and persists to localStorage.hrb-theme.
 * Pure helpers are DOM-free for testing; applyTheme touches the DOM.
 */

export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "hrb-theme";

export function parseStoredTheme(value: string | null): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

/** Effective theme = manual override if present, else OS preference. */
export function resolveTheme(stored: Theme | null, prefersDark: boolean): Theme {
  return stored ?? (prefersDark ? "dark" : "light");
}

export function nextTheme(current: Theme): Theme {
  return current === "dark" ? "light" : "dark";
}

// ---- DOM side (browser only) ----

export function getEffectiveTheme(): Theme {
  const stored = parseStoredTheme(
    typeof localStorage !== "undefined" ? localStorage.getItem(THEME_STORAGE_KEY) : null,
  );
  const prefersDark =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
  return resolveTheme(stored, prefersDark);
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage unavailable — keep in-DOM state only
  }
}
