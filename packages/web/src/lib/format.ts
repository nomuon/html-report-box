/** Deterministic ja formatting helpers (DOM-free, unit tested). */

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO datetime → "2026/07/10 21:30" (local time). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Bytes → human readable (e.g. "1.2 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes;
  let unit: string = "B";
  for (const u of units) {
    value /= 1024;
    unit = u;
    if (value < 1024) break;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}
