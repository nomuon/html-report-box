/**
 * Presigned upload with real progress. XMLHttpRequest is used because fetch
 * cannot report upload progress (DESIGN.md §4.1).
 *
 * Two transports (per upload.method):
 * - "post": multipart form (fields + file). Covers the S3 presigned POST and
 *   the local dev /local-upload route (same contract: fields + file, 204).
 * - "put":  raw body PUT with the supplied headers (R2 等、POST 非対応)。
 */
import type { PresignedUpload } from "@hrb/shared";

export function uploadToPresigned(
  upload: PresignedUpload,
  file: Blob,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
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

    if (upload.method === "put") {
      // 生バイトを PUT し、付随ヘッダー（content-type 等）を適用する。
      xhr.open("PUT", upload.url);
      for (const [k, v] of Object.entries(upload.headers)) xhr.setRequestHeader(k, v);
      xhr.send(file);
    } else {
      // presigned POST / ローカル /local-upload: fields + file の multipart。
      const form = new FormData();
      for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
      form.append("file", file);
      xhr.open("POST", upload.url);
      xhr.send(form);
    }
  });
}
