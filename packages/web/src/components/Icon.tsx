/**
 * インライン SVG アイコンセット（絵文字の代替）。
 * stroke ベース・currentColor 継承・24px viewBox 統一。外部フォント/CDN 非依存。
 */
import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "search"
  | "upload"
  | "upload-cloud"
  | "file"
  | "file-drop"
  | "inbox"
  | "moon"
  | "sun"
  | "rows"
  | "grid"
  | "link"
  | "flag"
  | "info"
  | "clock"
  | "check"
  | "check-circle"
  | "x"
  | "x-circle"
  | "ban"
  | "shield"
  | "shield-check"
  | "pencil"
  | "trash"
  | "refresh"
  | "lock"
  | "user"
  | "users"
  | "plus"
  | "chevron-down";

const PATHS: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="m6.5 9.5 5.5-5.5 5.5 5.5" />
      <path d="M4 20h16" />
    </>
  ),
  "upload-cloud": (
    <>
      <path d="M7 17.2A5 5 0 0 1 7.9 7.3a6 6 0 0 1 11.5 1.8A4.2 4.2 0 0 1 18.6 17" />
      <path d="M12 20v-8" />
      <path d="m8.5 15 3.5-3.5L15.5 15" />
    </>
  ),
  file: (
    <>
      <path d="M13.5 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M13.5 3V8h5" />
    </>
  ),
  "file-drop": (
    <>
      <path d="M13.5 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M13.5 3V8h5" />
      <path d="M12 11v6" />
      <path d="m9.5 14.5 2.5 2.5 2.5-2.5" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13.5 5.4 5.8A1.5 1.5 0 0 1 6.8 4.8h10.4a1.5 1.5 0 0 1 1.4 1l2.4 7.7V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" />
      <path d="M3 13.5h5.2a1 1 0 0 1 .9.6 3.2 3.2 0 0 0 5.8 0 1 1 0 0 1 .9-.6H21" />
    </>
  ),
  moon: <path d="M20.4 14.2A8.2 8.2 0 0 1 9.8 3.6a8.2 8.2 0 1 0 10.6 10.6Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M5 19l1.6-1.6M17.4 6.6 19 5" />
    </>
  ),
  rows: (
    <>
      <path d="M4 6.5h16" />
      <path d="M4 12h16" />
      <path d="M4 17.5h16" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.2" />
      <rect x="13" y="4" width="7" height="7" rx="1.2" />
      <rect x="4" y="13" width="7" height="7" rx="1.2" />
      <rect x="13" y="13" width="7" height="7" rx="1.2" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 6.8 13 4.9a4 4 0 0 1 5.7 5.7l-2 1.9" />
      <path d="M13 17.2 11 19a4 4 0 0 1-5.7-5.7l2-1.9" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4.5" />
      <path d="M5 4.5c4-2.4 7 2.4 11 0v9c-4 2.4-7-2.4-11 0" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.5h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 1.9" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.8 2.8L16.2 9.6" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
  "x-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.7 5.7l12.6 12.6" />
    </>
  ),
  shield: <path d="M12 3 5 5.8v5.4c0 4.4 3 8.1 7 9.8 4-1.7 7-5.4 7-9.8V5.8z" />,
  "shield-check": (
    <>
      <path d="M12 3 5 5.8v5.4c0 4.4 3 8.1 7 9.8 4-1.7 7-5.4 7-9.8V5.8z" />
      <path d="m9 11.8 2.2 2.2 4-4.2" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20h4l11-11a2.1 2.1 0 0 0-3-3L5 17z" />
      <path d="m13.5 7.5 3 3" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V4.8A1.3 1.3 0 0 1 10.3 3.5h3.4A1.3 1.3 0 0 1 15 4.8v1.7" />
      <path d="M6.3 6.5 7 19.2a1.5 1.5 0 0 0 1.5 1.3h7a1.5 1.5 0 0 0 1.5-1.3l.7-12.7" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 5.5v5h-5" />
      <path d="M4 18.5v-5h5" />
      <path d="M5.6 9A7 7 0 0 1 17.4 6.4L20 10.5M4 13.5l2.6 4.1A7 7 0 0 0 18.4 15" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="1.8" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <path d="M12 14.5v2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.8" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.4" />
      <path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0" />
      <path d="M16 5.6a3.4 3.4 0 0 1 0 5.8" />
      <path d="M17.8 13.9a6.2 6.2 0 0 1 3.4 5.6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  "chevron-down": <path d="m6 9.5 6 6 6-6" />,
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** px サイズ（width/height 共通）。デフォルト 18 */
  size?: number;
}

export function Icon({ name, size = 18, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

/** ブランドマーク: 箱 + 盾（セキュリティスキャンを内包するレポートボックス） */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className="hrb-brandmark"
    >
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" className="hrb-brandmark__tile" />
      <path
        d="M16 7.5 9.5 10v5c0 4 2.6 7.1 6.5 8.5 3.9-1.4 6.5-4.5 6.5-8.5v-5z"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="m13.2 15.6 2.1 2.1 3.6-3.9"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
