import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunConvert, RunConvertError, JobFailedError, WaitTimeoutError, verifySignature, constructEvent } from "../dist/esm/index.js";

/** A fake fetch: `routes` maps "METHOD path" (or a function) to responses, and every call is recorded. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method ?? "GET", path: u.pathname.replace(/^\/v3/, ""), query: Object.fromEntries(u.searchParams), headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    const r = await handler(call, calls.length);
    if (r instanceof Error) throw r;
    const { status = 200, json, text, headers = {} } = r;
    return new Response(json !== undefined ? JSON.stringify(json) : (text ?? null), { status, headers });
  };
  return { fn, calls };
}
const ok = (data, meta) => ({ json: { success: true, data, ...(meta ? { meta } : {}) } });
const fail = (status, code, message) => ({ status, json: { success: false, error: { code, message } } });
const client = (fetch, extra = {}) => new RunConvert({ apiKey: "rc_live_test", baseUrl: "https://api.example/v3", fetch, maxRetries: 2, ...extra });

test("sends the key and unwraps { success, data }", async () => {
  const { fn, calls } = fakeFetch(() => ok({ user: { email: "a@b.c" }, credits: { mode: "wallet", total_remaining: 42 } }));
  const me = await client(fn).me();
  assert.equal(me.credits.total_remaining, 42);
  assert.equal(calls[0].headers.Authorization, "Bearer rc_live_test");
  assert.match(calls[0].headers["User-Agent"], /^runconvert-node\//);
});

test("API errors become RunConvertError with status and code", async () => {
  const { fn } = fakeFetch(() => fail(422, "BILLING_INSUFFICIENT_CREDITS", "Insufficient credits."));
  await assert.rejects(client(fn).jobs.get("job_1"), (e) => e instanceof RunConvertError && e.status === 422 && e.code === "BILLING_INSUFFICIENT_CREDITS" && e.message === "Insufficient credits.");
});

test("GET retries 503 then succeeds", async () => {
  const { fn, calls } = fakeFetch((_, n) => (n < 3 ? { status: 503, text: "busy" } : ok({ id: "job_1", status: "finished" })));
  const job = await client(fn).jobs.get("job_1");
  assert.equal(job.status, "finished");
  assert.equal(calls.length, 3);
});

test("creating a job is not retried after a 500 (no duplicate jobs)", async () => {
  const { fn, calls } = fakeFetch(() => fail(500, "INTERNAL", "boom"));
  await assert.rejects(client(fn).jobs.create({ tasks: {} }), (e) => e.status === 500);
  assert.equal(calls.length, 1);
});

test("creating a job is retried on 429 (rejected before any work)", async () => {
  const { fn, calls } = fakeFetch((_, n) => (n === 1 ? { status: 429, json: { success: false, error: { code: "ACTIVE_JOB_LIMIT_REACHED", message: "x" } }, headers: { "retry-after": "0" } } : ok({ id: "job_1", status: "waiting", tasks: [] })));
  const job = await client(fn).jobs.create({ tasks: {} });
  assert.equal(job.id, "job_1");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].query.include, "tasks");
});

test("list passes filters and returns meta; all() walks every page", async () => {
  const { fn, calls } = fakeFetch((c) => ok([{ id: `job_p${c.query.page}`, status: "finished" }], { page: Number(c.query.page), per_page: 1, total: 2, total_pages: 2 }));
  const rc = client(fn);
  const page = await rc.jobs.list({ status: "finished", tag: "x", page: 1, perPage: 1 });
  assert.deepEqual(page.meta.total_pages, 2);
  assert.equal(calls[0].query["filter[status]"], "finished");
  assert.equal(calls[0].query["filter[tag]"], "x");
  const ids = [];
  for await (const j of rc.jobs.all({ perPage: 1 })) ids.push(j.id);
  assert.deepEqual(ids, ["job_p1", "job_p2"]);
});

test("wait polls until finished and reports progress", async () => {
  const states = ["waiting", "processing", "finished"];
  const { fn } = fakeFetch((_, n) => ok({ id: "job_1", status: states[Math.min(n - 1, 2)], tasks: [] }));
  const seen = [];
  const job = await client(fn).jobs.wait("job_1", { onUpdate: (j) => seen.push(j.status) });
  assert.equal(job.status, "finished");
  assert.deepEqual(seen, states);
});

test("wait throws JobFailedError with the failed task's reason", async () => {
  const { fn } = fakeFetch(() => ok({ id: "job_1", status: "error", tasks: [{ name: "convert-1", operation: "convert", status: "error", code: "INVALID_DATA", reason: "INPUT_EMPTY", message: "The file is empty." }] }));
  await assert.rejects(client(fn).jobs.wait("job_1"), (e) => e instanceof JobFailedError && e.task.reason === "INPUT_EMPTY" && e.message === "The file is empty.");
  const job = await client(fn).jobs.wait("job_1", { throwOnError: false });
  assert.equal(job.status, "error");
});

test("wait gives up with WaitTimeoutError", async () => {
  const { fn } = fakeFetch(() => ok({ id: "job_1", status: "processing", tasks: [] }));
  await assert.rejects(client(fn).jobs.wait("job_1", { timeout: 1 }), WaitTimeoutError);
});

test("delete handles 204; operations queries are lower-cased", async () => {
  const { fn, calls } = fakeFetch((c) => (c.method === "DELETE" ? { status: 204 } : ok({ input: "mp4", output: "mp3", engines: [] })));
  const rc = client(fn);
  await rc.jobs.delete("job_1");
  await rc.operations.forPair("MP4", "MP3");
  assert.deepEqual(calls[1].query, { input: "mp4", output: "mp3" });
});

test("webhook signatures: valid, tampered, malformed", () => {
  const body = JSON.stringify({ event: "job.finished", job: { id: "job_1", status: "finished" } });
  const sig = "sha256=" + createHmac("sha256", "whsec_x").update(body).digest("hex");
  assert.equal(verifySignature(body, sig, "whsec_x"), true);
  assert.equal(verifySignature(Buffer.from(body), sig, "whsec_x"), true);
  assert.equal(verifySignature(body + " ", sig, "whsec_x"), false);
  assert.equal(verifySignature(body, sig, "other"), false);
  assert.equal(verifySignature(body, "sha256=nothex", "whsec_x"), false);
  assert.equal(verifySignature(body, undefined, "whsec_x"), false);
  assert.equal(constructEvent(body, sig, "whsec_x").job.id, "job_1");
  assert.throws(() => constructEvent(body, "sha256=" + "0".repeat(64), "whsec_x"));
});

test("convert(): uploads a local file, waits, downloads the result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rc-"));
  const src = join(dir, "notes.txt");
  await writeFile(src, "hello");
  let polls = 0;
  const { fn, calls } = fakeFetch((c) => {
    if (c.method === "POST" && c.path === "/jobs") {
      return ok({ id: "job_1", status: "waiting", tasks: [{ name: "import-1", operation: "import/direct/upload", status: "waiting", upload_url: "https://up.example/u/1?token=t" }] });
    }
    if (c.method === "PUT") return { status: 200, text: "" };
    if (c.path === "/jobs/job_1") {
      polls++;
      return ok({ id: "job_1", status: polls < 2 ? "processing" : "finished", tasks: [{ name: "export-1", operation: "export/url", status: "finished", result: { files: [{ filename: "notes.pdf", url: "https://dl.example/notes.pdf", size: 3 }] } }] });
    }
    if (c.path === "/notes.pdf") return { status: 200, text: "PDF" };
    return { status: 404, text: "?" };
  });
  const res = await client(fn).convert(src, { to: "pdf", outDir: join(dir, "out"), options: { page_size: "a4" } });
  const create = JSON.parse(calls[0].body);
  assert.deepEqual(create.tasks["convert-1"], { page_size: "a4", operation: "convert", input: "import-1", input_format: "txt", output_format: "pdf" });
  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put.query.filename, "notes.txt");
  assert.equal(put.query.token, "t");
  assert.equal(res.files[0].filename, "notes.pdf");
  assert.equal(await readFile(res.saved[0], "utf8"), "PDF");
});

test("convert(): a URL is imported, not uploaded", async () => {
  const { fn, calls } = fakeFetch((c) => (c.method === "POST" ? ok({ id: "job_2", status: "waiting", tasks: [] }) : ok({ id: "job_2", status: "finished", tasks: [] })));
  await client(fn).convert("https://example.com/a/talk.MP4?x=1", { to: "mp3" });
  const tasks = JSON.parse(calls[0].body).tasks;
  assert.deepEqual(tasks["import-1"], { operation: "import/url", source_url: "https://example.com/a/talk.MP4?x=1" });
  assert.equal(tasks["convert-1"].input_format, "mp4");
  assert.ok(!calls.some((c) => c.method === "PUT"));
});

test("convert(): bytes need a filename or from", async () => {
  const rc = client(fakeFetch(() => ok({})).fn);
  await assert.rejects(rc.convert(new Uint8Array([1]), { to: "pdf" }), /source format/);
});
