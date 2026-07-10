/**
 * Presigned POST upload with real progress. XMLHttpRequest is used because
 * fetch cannot report upload progress (DESIGN.md §4.1). Works against both
 * the S3 presigned POST and the local dev /local-upload endpoint (same
 * multipart form contract: fields + file, 204 on success).
 */
import type { PresignedUpload } from "@hrb/shared";

export function uploadToPresigned(
  upload: PresignedUpload,
  file: Blob,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
    form.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", upload.url);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) {
        onProgress(Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("upload failed (network error)"));
    xhr.onabort = () => reject(new Error("upload aborted"));
    xhr.send(form);
  });
}
