import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PresignedUpload } from "@hrb/shared";
import { UploadAbortedError, uploadToPresigned } from "./upload.ts";

/** Minimal XMLHttpRequest stand-in: records the request and lets the test drive events. */
class FakeXHR {
  static last: FakeXHR | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  upload = { onprogress: null as ((ev: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
    FakeXHR.last = this;
  }
  abort() {
    this.onabort?.();
  }
}

const realXHR = globalThis.XMLHttpRequest;

beforeEach(() => {
  FakeXHR.last = null;
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
  globalThis.XMLHttpRequest = realXHR;
});

const basePresigned = {
  key: "staging/r1/u1",
  expiresInSeconds: 900,
  maxSizeBytes: 5 * 1024 * 1024,
};

function progressEvent(loaded: number, total: number): ProgressEvent {
  return { lengthComputable: true, loaded, total } as ProgressEvent;
}

describe("uploadToPresigned (POST transport)", () => {
  test("sends fields + file as multipart form and reports progress", async () => {
    const upload: PresignedUpload = {
      ...basePresigned,
      method: "post",
      url: "/local-upload",
      fields: { key: "staging/r1/u1", policy: "p" },
      headers: {},
    };
    const file = new Blob(["<html></html>"], { type: "text/html" });
    const percents: number[] = [];
    const promise = uploadToPresigned(upload, file, (p) => percents.push(p));

    const xhr = FakeXHR.last!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/local-upload");
    expect(xhr.body).toBeInstanceOf(FormData);
    const form = xhr.body as FormData;
    expect(form.get("key")).toBe("staging/r1/u1");
    expect(form.get("policy")).toBe("p");
    expect(form.get("file")).toBeInstanceOf(Blob);

    xhr.upload.onprogress?.(progressEvent(5, 10));
    xhr.status = 204;
    xhr.onload?.();
    await promise;
    expect(percents).toEqual([50, 100]);
  });
});

describe("uploadToPresigned (PUT transport)", () => {
  test("PUTs the raw body and applies headers", async () => {
    const upload: PresignedUpload = {
      ...basePresigned,
      method: "put",
      url: "https://r2.example/staging/r1/u1?sig=abc",
      fields: {},
      headers: { "content-type": "text/html" },
    };
    const file = new Blob(["<html></html>"], { type: "text/html" });
    const promise = uploadToPresigned(upload, file);

    const xhr = FakeXHR.last!;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("https://r2.example/staging/r1/u1?sig=abc");
    expect(xhr.headers["content-type"]).toBe("text/html");
    // raw body, not a multipart form.
    expect(xhr.body).toBe(file);
    expect(xhr.body).not.toBeInstanceOf(FormData);

    xhr.status = 200;
    xhr.onload?.();
    await promise;
  });

  test("rejects on a non-2xx status", async () => {
    const upload: PresignedUpload = {
      ...basePresigned,
      method: "put",
      url: "https://r2.example/staging/r1/u1",
      fields: {},
      headers: {},
    };
    const promise = uploadToPresigned(upload, new Blob(["x"]));
    const xhr = FakeXHR.last!;
    xhr.status = 403;
    xhr.onload?.();
    await expect(promise).rejects.toThrow("HTTP 403");
  });
});

describe("uploadToPresigned (abort)", () => {
  const upload: PresignedUpload = {
    ...basePresigned,
    method: "post",
    url: "/local-upload",
    fields: {},
    headers: {},
  };

  test("signal の abort で XHR を中断し UploadAbortedError で reject する", async () => {
    const controller = new AbortController();
    const promise = uploadToPresigned(upload, new Blob(["x"]), undefined, controller.signal);
    expect(FakeXHR.last).not.toBeNull();
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(UploadAbortedError);
  });

  test("abort 済みの signal では送信せずに即 reject する", async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = uploadToPresigned(upload, new Blob(["x"]), undefined, controller.signal);
    await expect(promise).rejects.toBeInstanceOf(UploadAbortedError);
    expect(FakeXHR.last).toBeNull();
  });
});
