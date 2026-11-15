# RunConvert SDK for Node.js

Convert files between 240+ formats (3,000+ conversions) with the [RunConvert API](https://www.runconvert.com/docs):
documents, images, video, audio, ebooks, archives, fonts and CAD. Typed, no dependencies, Node.js 18+.

```bash
npm install runconvert
```

```ts
import { RunConvert } from "runconvert";

const rc = new RunConvert({ apiKey: process.env.RUNCONVERT_API_KEY });

// One call: upload, convert, wait, download.
const { saved } = await rc.convert("report.docx", { to: "pdf", outDir: "out" });
console.log(saved); // [ 'out/report.pdf' ]
```

Get an API key in **Dashboard → API Keys** on [runconvert.com](https://www.runconvert.com). The client reads
`RUNCONVERT_API_KEY` from the environment when `apiKey` is left out. Keep keys on the server.

## Convert

```ts
// From a URL (imported by RunConvert, nothing to upload)
await rc.convert("https://example.com/talk.mp4", { to: "mp3", options: { audioBitrate: "192k" } });

// From bytes or a stream: give a filename (or `from`)
await rc.convert(buffer, { to: "jpg", filename: "photo.heic", outDir: "out" });

// Progress and a time limit
await rc.convert("movie.mov", {
  to: "mp4",
  outDir: "out",
  onUpdate: (job) => console.log(job.status),
  timeout: 10 * 60_000,
});
```

`convert` returns `{ job, files, saved }`: the finished job, the result files with temporary download links,
and the local paths when `outDir` is given.

Options for a conversion (bitrate, quality, page size, trim…) come from
`rc.operations.forPair("mp4", "mp3")` and go in `options`.

## Jobs with your own tasks

A job is named tasks that run in order: **import → convert → export**. Tasks refer to each other in `input`.

```ts
// Merge three PDFs into one
const job = await rc.jobs.create({
  tag: "merge",
  tasks: {
    a: { operation: "import/url", source_url: "https://example.com/cover.pdf" },
    b: { operation: "import/url", source_url: "https://example.com/body.pdf" },
    c: { operation: "import/url", source_url: "https://example.com/appendix.pdf" },
    merge: { operation: "convert", input: ["a", "b", "c"], input_format: "pdf", output_format: "pdf" },
    export: { operation: "export/url", input: "merge" },
  },
});

const done = await rc.jobs.wait(job.id);
for (const file of Jobs.exportedFiles(done)) await rc.files.download(file, "out");
```

(`Jobs` is exported too: `import { RunConvert, Jobs } from "runconvert"`.)

Uploading your own file:

```ts
import { Jobs } from "runconvert";

const job = await rc.jobs.create({
  tasks: {
    upload: { operation: "import/direct/upload" },
    convert: { operation: "convert", input: "upload", input_format: "png", output_format: "webp", image_quality: 80 },
    export: { operation: "export/url", input: "convert" },
  },
});
await rc.files.upload(job.tasks!.find((t) => t.name === "upload")!, "image.png");
const finished = await rc.jobs.wait(job.id);
for (const file of Jobs.exportedFiles(finished)) await rc.files.download(file, "out");
```

| Method | What it does |
|---|---|
| `rc.jobs.create({ tasks, tag?, metadata? })` | Create a job (returned with its tasks) |
| `rc.jobs.get(id)` | A job with its tasks |
| `rc.jobs.list({ status?, tag?, page?, perPage? })` | One page: `{ data, meta }` |
| `rc.jobs.all({ … })` | Every job: `for await (const job of rc.jobs.all())` |
| `rc.jobs.wait(id, { timeout?, onUpdate?, throwOnError? })` | Poll until `finished` or `error` |
| `rc.jobs.cancel(id)` / `rc.jobs.delete(id)` | Stop pending tasks (refunds unfinished ones) / delete |
| `rc.files.upload(task, file, filename?)` | PUT a path, bytes or stream to an upload task |
| `rc.files.download(file, dir)` | Save a result file; returns the path |
| `rc.operations.list({ category? })` | Every format and its targets (no key needed) |
| `rc.operations.forInput("mp4")` | Targets for one format, with credit costs |
| `rc.operations.forPair("mp4", "mp3")` | Engines and options for one conversion |
| `rc.me()` | Account, team and credit balance |

## Webhooks

Verify the `X-RunConvert-Signature` header against the **raw** body before using an event:

```ts
import express from "express";
import { constructEvent } from "runconvert";

app.post("/webhooks/runconvert", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = constructEvent(req.body, req.header("X-RunConvert-Signature"), process.env.RUNCONVERT_WEBHOOK_SECRET!);
  } catch {
    return res.sendStatus(400);
  }
  if (event.event === "job.finished") console.log("done", event.job?.id);
  res.sendStatus(200);
});
```

`verifySignature(body, header, secret)` returns `true` or `false` if you'd rather not throw.

## Errors

| Error | When |
|---|---|
| `RunConvertError` | The API said no: `status` (HTTP), `code` (e.g. `BILLING_INSUFFICIENT_CREDITS`), `message` |
| `JobFailedError` | `wait`/`convert` saw the job end in `error`; `task.code`, `task.reason` and `task.message` say why |
| `WaitTimeoutError` | `wait` ran past its `timeout` |

```ts
import { RunConvertError, JobFailedError } from "runconvert";

try {
  await rc.convert("song.ncm", { to: "mp3" });
} catch (err) {
  if (err instanceof JobFailedError) console.log(err.task?.reason, err.message);
  else if (err instanceof RunConvertError && err.code === "BILLING_INSUFFICIENT_CREDITS") console.log("Top up credits");
  else throw err;
}
```

Network errors, `429` and `5xx` are retried twice with backoff (`maxRetries`). Creating a job is only
retried when the request never reached the API, so a job is never created twice.

## Options

```ts
new RunConvert({
  apiKey: "rc_live_…",                       // default: RUNCONVERT_API_KEY
  baseUrl: "https://api.runconvert.com/v3",  // default
  timeout: 60_000,                           // per request, ms (uploads/downloads: none)
  maxRetries: 2,
  fetch: customFetch,                        // proxies, tests
});
```

## Development

```bash
npm install
npm test                                    # build + unit tests (no network)
RUNCONVERT_API_KEY=rc_live_… npm run test:live   # real API, about 2 credits
```

The API this SDK follows is described in OpenAPI 3.1 (`docs/openapi/runconvert-v3.yaml` in the backend repo).

## License

MIT
