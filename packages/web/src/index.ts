/**
 * @hrb/web — React SPA (react-router + TanStack Query, built with `bun build`).
 * The browser entrypoint is src/main.tsx (loaded from index.html).
 * This module re-exports the DOM-light logic units for tests / tooling.
 */
export const PACKAGE_NAME = "@hrb/web";
export { App } from "./App.tsx";

export { ApiClient, ApiError, isApiError } from "./lib/api.ts";
export type { ApiClientOptions, ReportFlagView } from "./lib/api.ts";
export {
  CognitoAuthProvider,
  DEV_USER_HEADER,
  DEV_USER_STORAGE_KEY,
  DevAuthProvider,
  createAuthProvider,
} from "./lib/auth.ts";
export type { AuthProvider, AuthSession, StorageLike } from "./lib/auth.ts";
export {
  DROPZONE_INITIAL,
  MSG_BAD_EXTENSION,
  MSG_MULTIPLE_FILES,
  MSG_TOO_LARGE,
  dropzoneReducer,
  kindForFilename,
  validateFiles,
} from "./state/dropzone.ts";
export type { DropzoneEvent, DropzoneState, SelectedFile } from "./state/dropzone.ts";
export { highlightSegments } from "./lib/highlight.ts";
export { formatBytes, formatDateTime } from "./lib/format.ts";
export { extractHtmlTitle, titleFromFilename } from "./lib/html-title.ts";
