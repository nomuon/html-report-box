/**
 * Scanner configuration. All thresholds are injectable so rules stay testable
 * and ops can tune them without code changes. Portable (Node 22).
 */
import {
  MAX_ZIP_COMPRESSION_RATIO,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
} from "@hrb/shared";

export interface ResolvedScannerConfig {
  /** Shannon entropy (bits/char) above which an inline script is "high entropy". */
  entropyThreshold: number;
  /** Fraction of script characters that belong to \xNN / \uNNNN / %NN escapes. */
  escapeDensityThreshold: number;
  /** Minimum inline-script length (chars) before obfuscation metrics apply. */
  minObfuscationCodeLength: number;
  /** How many of the 3 obfuscation signals must fire to raise a warn. */
  minObfuscationSignals: number;
  /** data: URI decoded payloads above this (non-media MIME) are blocked. */
  largeDataUriBytes: number;
  /** meta refresh with delay <= this (seconds) counts as "immediate". */
  immediateRefreshSeconds: number;
  /** Lower-cased phrases that mark a page as impersonating a login brand. */
  brandVocabulary: readonly string[];
  /** Lower-cased extensions (with dot) considered executable download bait. */
  executableExtensions: readonly string[];
  /** Lower-cased substrings identifying browser cryptominer payloads. */
  minerSignatures: readonly string[];
  // ---- zip limits (measured, never trusted from headers) ----
  maxZipEntries: number;
  maxZipUncompressedBytes: number;
  maxZipCompressionRatio: number;
  /** Compression-ratio check only applies once measured output exceeds this. */
  minRatioCheckBytes: number;
}

export type ScannerConfig = Partial<ResolvedScannerConfig>;

export const DEFAULT_SCANNER_CONFIG: ResolvedScannerConfig = {
  entropyThreshold: 5.2,
  escapeDensityThreshold: 0.05,
  minObfuscationCodeLength: 120,
  minObfuscationSignals: 2,
  largeDataUriBytes: 100 * 1024,
  immediateRefreshSeconds: 2,
  brandVocabulary: [
    // EN brands / credential phrases
    "okta",
    "onelogin",
    "office 365",
    "microsoft 365",
    "microsoft account",
    "outlook",
    "onedrive",
    "sharepoint",
    "google account",
    "google workspace",
    "gmail",
    "apple id",
    "icloud",
    "paypal",
    "docusign",
    "dropbox",
    "salesforce",
    "verify your account",
    "verify your identity",
    "confirm your password",
    "password expired",
    "password has expired",
    "session has expired",
    "sign in to continue",
    "unusual sign-in activity",
    // JA credential phrases
    "アカウントを確認",
    "アカウントの確認",
    "アカウントが一時停止",
    "パスワードの有効期限",
    "本人確認が必要",
    "再度ログインして",
    "ログインし直して",
    "セキュリティ警告",
  ],
  executableExtensions: [
    ".exe",
    ".hta",
    ".ps1",
    ".psm1",
    ".scr",
    ".bat",
    ".cmd",
    ".msi",
    ".msix",
    ".msp",
    ".vbs",
    ".vbe",
    ".wsf",
    ".wsh",
    ".jse",
    ".jar",
    ".dll",
    ".apk",
    ".dmg",
    ".pkg",
    ".deb",
    ".rpm",
    ".lnk",
    ".iso",
    ".img",
    ".reg",
    ".com",
    ".cpl",
  ],
  minerSignatures: [
    "coinhive",
    "coin-hive",
    "authedmine",
    "coinimp",
    "crypto-loot",
    "cryptoloot",
    "webminepool",
    "deepminer",
    "jsecoin",
    "cryptonight",
    "monerominer",
    "minero.cc",
    "stratum+tcp",
  ],
  maxZipEntries: MAX_ZIP_ENTRIES,
  maxZipUncompressedBytes: MAX_ZIP_UNCOMPRESSED_BYTES,
  maxZipCompressionRatio: MAX_ZIP_COMPRESSION_RATIO,
  minRatioCheckBytes: 100 * 1024,
};

export function resolveConfig(config?: ScannerConfig): ResolvedScannerConfig {
  return { ...DEFAULT_SCANNER_CONFIG, ...config };
}
