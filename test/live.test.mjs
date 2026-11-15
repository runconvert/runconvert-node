// Live tests against the real API. Needs RUNCONVERT_API_KEY; each full run converts one
// small text file (about 1 credit). Skipped without a key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunConvert, RunConvertError } from "../dist/esm/index.js";

const key = process.env.RUNCONVERT_API_KEY;
const live = { skip: !key && "set RUNCONVERT_API_KEY to run live tests", timeout: 180_000 };

test("me(): the account behind the key", live, async () => {
  const me = await new RunConvert().me();
  assert.ok(me.team?.name !== undefined || me.user?.email, "has a user or team");
  assert.ok(me.credits, "has a credit balance");
});

test("operations: catalog, targets, engines (public)", live, async () => {
  const rc = new RunConvert({ apiKey: "" });
  const catalog = await rc.operations.list({ category: "document" });
  assert.ok(catalog.formats.some((f) => f.format === "txt"));
  const txt = await rc.operations.forInput("TXT");
  assert.ok(txt.outputs.some((o) => o.format === "pdf"));
  const pair = await rc.operations.forPair("mp4", "mp3");
  assert.ok(pair.engines.length > 0);
});

test("convert(): upload a text file, get a PDF back", live, async () => {
  const dir = await mkdtemp(join(tmpdir(), "rc-live-"));
  const src = join(dir, "sdk-live-test.txt");
  await writeFile(src, "RunConvert Node SDK live test\nLine two\n\nCafé – 你好 – Привет\n");
  const rc = new RunConvert();
  const statuses = new Set();
  const res = await rc.convert(src, { to: "pdf", outDir: join(dir, "out"), tag: "sdk-node-live-test", onUpdate: (j) => statuses.add(j.status), timeout: 150_000 });
  assert.equal(res.job.status, "finished");
  assert.equal(res.files.length, 1);
  assert.match(res.files[0].filename, /\.pdf$/);
  const pdf = await readFile(res.saved[0]);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  // The job is listed under its tag.
  const page = await rc.jobs.list({ tag: "sdk-node-live-test", perPage: 5 });
  assert.ok(page.data.some((j) => j.id === res.job.id));
  console.log(`  job ${res.job.id}: ${[...statuses].join(" → ")}, ${res.job.credits_used} credit(s), ${pdf.length} bytes`);
});

test("a bad key gives a RunConvertError, not a crash", live, async () => {
  await assert.rejects(new RunConvert({ apiKey: "rc_live_invalid", maxRetries: 0 }).me(), (e) => e instanceof RunConvertError && e.status === 401 && e.code.length > 0);
});
