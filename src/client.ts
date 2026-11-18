import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { JobFailedError, RunConvertError, WaitTimeoutError } from "./errors.js";
import type {
  Category, InputFormat, Job, JobCreateParams, JobStatus, ListMeta, Me, OperationsCatalog,
  Page, PairEngines, ResultFile, Task, TaskDefinition,
} from "./types.js";
import { constructEvent, verifySignature } from "./webhooks.js";

export const VERSION = "0.1.0"; // x-release-please-version

export interface ClientOptions {
  /** API key from Dashboard → API Keys. Defaults to the RUNCONVERT_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to https://api.runconvert.com/v3. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds (default 60 000). Uploads and downloads have none. */
  timeout?: number;
  /** Retries for network errors, 429 and 5xx (default 2). Creating a job is never retried after it reached the server. */
  maxRetries?: number;
  /** A custom fetch, for proxies or tests. */
  fetch?: typeof fetch;
}

/** A local file path, file bytes, or a readable stream. */
export type FileInput = string | Uint8Array | Blob | NodeJS.ReadableStream;

export interface WaitOptions {
  /** Give up after this many milliseconds (default: no limit). */
  timeout?: number;
  /** Called after every poll, e.g. to show progress. */
  onUpdate?: (job: Job) => void;
  /** Throw JobFailedError when the job ends in `error` (default true). */
  throwOnError?: boolean;
  signal?: AbortSignal;
}

export interface ConvertOptions {
  /** Target format extension, e.g. "mp3". */
  to: string;
  /** Source format; read from the file name or URL when left out. */
  from?: string;
  /** Engine options for the convert task, e.g. { audioBitrate: "192k" }. */
  options?: Record<string, unknown>;
  /** Save the results here: a folder (created if needed). Without it, nothing is downloaded. */
  outDir?: string;
  /** File name for an upload from bytes or a stream (sets the source format too). */
  filename?: string;
  tag?: string;
  /** Called while the job runs. */
  onUpdate?: (job: Job) => void;
  /** Give up waiting after this many milliseconds. */
  timeout?: number;
}

export interface ConvertResult {
  job: Job;
  /** The converted files, with temporary download links. */
  files: ResultFile[];
  /** Local paths, when `outDir` was given. */
  saved: string[];
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("Aborted")); }, { once: true });
  });

/**
 * The RunConvert API client.
 *
 * ```ts
 * const rc = new RunConvert({ apiKey: process.env.RUNCONVERT_API_KEY });
 * const { saved } = await rc.convert("video.mov", { to: "mp4", outDir: "out" });
 * ```
 */
export class RunConvert {
  readonly jobs: Jobs;
  readonly operations: Operations;
  readonly files: Files;
  readonly webhooks = { verify: verifySignature, constructEvent };

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeout: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env.RUNCONVERT_API_KEY ?? "";
    this.#baseUrl = (options.baseUrl ?? "https://api.runconvert.com/v3").replace(/\/+$/, "");
    this.#timeout = options.timeout ?? 60_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!this.#fetch) throw new Error("RunConvert needs Node.js 18 or newer (global fetch), or pass options.fetch.");
    this.jobs = new Jobs(this);
    this.operations = new Operations(this);
    this.files = new Files(this);
  }

  /** The account, team and credit balance behind the API key. */
  me(): Promise<Me> {
    return this.request<Me>("GET", "/me");
  }

  /**
   * Converts one file in one call: uploads it (or imports it from a URL), converts it,
   * waits, and saves the results to `outDir` when given.
   *
   * ```ts
   * await rc.convert("report.docx", { to: "pdf", outDir: "out" });
   * await rc.convert("https://example.com/talk.mp4", { to: "mp3", options: { audioBitrate: "192k" } });
   * ```
   */
  async convert(input: FileInput, opts: ConvertOptions): Promise<ConvertResult> {
    const isUrl = typeof input === "string" && /^https?:\/\//i.test(input);
    const name = opts.filename ?? (typeof input === "string" ? (isUrl ? new URL(input).pathname : input) : "");
    const from = (opts.from ?? extname(name).slice(1)).toLowerCase();
    if (!from) throw new Error("Can't tell the source format: pass `from` (e.g. { from: \"mp4\" }) or `filename`.");
    const to = opts.to.toLowerCase().replace(/^\./, "");
    const importTask: TaskDefinition = isUrl
      ? { operation: "import/url", source_url: input as string }
      : { operation: "import/direct/upload" };
    let job = await this.jobs.create({
      tag: opts.tag,
      tasks: {
        "import-1": importTask,
        "convert-1": { ...opts.options, operation: "convert", input: "import-1", input_format: from, output_format: to },
        "export-1": { operation: "export/url", input: "convert-1" },
      },
    });
    if (!isUrl) {
      const upload = job.tasks?.find((t) => t.name === "import-1");
      if (!upload?.upload_url) throw new RunConvertError("The job has no upload URL", 0, "", job);
      await this.files.upload(upload, input, opts.filename);
    }
    job = await this.jobs.wait(job.id, { onUpdate: opts.onUpdate, timeout: opts.timeout });
    const files = Jobs.exportedFiles(job);
    const saved = opts.outDir ? await Promise.all(files.map((f) => this.files.download(f, opts.outDir!))) : [];
    return { job, files, saved };
  }

  /** @internal Sends a request and unwraps `{ success, data }`. */
  async request<T>(method: string, path: string, body?: unknown, query?: Record<string, unknown>): Promise<T> {
    return (await this.requestRaw<T>(method, path, body, query)).data;
  }

  /** @internal Like request, keeping `meta` (lists). */
  async requestRaw<T>(method: string, path: string, body?: unknown, query?: Record<string, unknown>): Promise<{ data: T; meta: ListMeta }> {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": `runconvert-node/${VERSION} node/${process.version}` };
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Only a request that never reached the server is safe to repeat for POST /jobs (no duplicate jobs).
    const idempotent = method !== "POST" || /\/cancel$/.test(path);

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.#timeout) });
      } catch (err) {
        const reached = (err as Error)?.name === "TimeoutError";
        if (attempt < this.#maxRetries && (idempotent || !reached)) { await sleep(backoff(attempt)); continue; }
        throw new RunConvertError(`Request to RunConvert failed: ${(err as Error)?.message ?? err}`, 0);
      }
      if (RETRY_STATUS.has(res.status) && attempt < this.#maxRetries && (idempotent || res.status === 429)) {
        await sleep(retryAfter(res) ?? backoff(attempt));
        continue;
      }
      if (res.status === 204) return { data: undefined as T, meta: {} };
      const text = await res.text();
      let json: { success?: boolean; data?: T; meta?: ListMeta; error?: { code?: string; message?: string } } | undefined;
      try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
      if (!res.ok || json?.success === false) {
        throw new RunConvertError(json?.error?.message || `RunConvert API error (HTTP ${res.status})`, res.status, json?.error?.code ?? "", json ?? text);
      }
      return { data: json?.data as T, meta: json?.meta ?? {} };
    }
  }

  /** @internal Plain HTTP for uploads and downloads (no envelope, no timeout). */
  rawFetch(url: string, init: RequestInit): Promise<Response> {
    return this.#fetch(url, init);
  }
}

const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() / 2);
function retryAfter(res: Response): number | undefined {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 30_000) : undefined;
}

export class Jobs {
  constructor(private readonly client: RunConvert) {}

  /** Creates a job. The returned job includes its tasks (an upload task carries `upload_url`). */
  create(params: JobCreateParams): Promise<Job> {
    return this.client.request<Job>("POST", "/jobs", params, { include: "tasks" });
  }

  /** Gets a job with its tasks. */
  get(id: string): Promise<Job> {
    return this.client.request<Job>("GET", `/jobs/${encodeURIComponent(id)}`, undefined, { include: "tasks" });
  }

  /** One page of jobs, newest first. */
  async list(params: { status?: JobStatus; tag?: string; page?: number; perPage?: number; includeTasks?: boolean } = {}): Promise<Page<Job>> {
    const { data, meta } = await this.client.requestRaw<Job[]>("GET", "/jobs", undefined, {
      "filter[status]": params.status, "filter[tag]": params.tag, page: params.page, per_page: params.perPage,
      include: params.includeTasks ? "tasks" : undefined,
    });
    return { data: data ?? [], meta };
  }

  /** Every job, page by page: `for await (const job of rc.jobs.all({ status: "finished" }))`. */
  async *all(params: { status?: JobStatus; tag?: string; perPage?: number; includeTasks?: boolean } = {}): AsyncGenerator<Job> {
    for (let page = 1; ; page++) {
      const { data, meta } = await this.list({ ...params, page });
      yield* data;
      if (!data.length || (meta.total_pages !== undefined && page >= meta.total_pages)) return;
    }
  }

  /** Cancels a job's pending tasks; credits for unfinished tasks are refunded. */
  cancel(id: string): Promise<Job> {
    return this.client.request<Job>("POST", `/jobs/${encodeURIComponent(id)}/cancel`);
  }

  /** Deletes a job. */
  async delete(id: string): Promise<void> {
    await this.client.request<void>("DELETE", `/jobs/${encodeURIComponent(id)}`);
  }

  /**
   * Polls until the job is `finished` or `error` (0.7 s, slowing to 3 s between polls).
   * Throws JobFailedError for a failed job unless `throwOnError: false`.
   */
  async wait(id: string, opts: WaitOptions = {}): Promise<Job> {
    const started = Date.now();
    let delay = 700;
    for (;;) {
      const job = await this.get(id);
      opts.onUpdate?.(job);
      if (job.status === "finished") return job;
      if (job.status === "error") {
        if (opts.throwOnError === false) return job;
        throw new JobFailedError(job, job.tasks?.find((t) => t.status === "error"));
      }
      if (opts.timeout !== undefined && Date.now() - started + delay > opts.timeout) throw new WaitTimeoutError(job, opts.timeout);
      await sleep(delay, opts.signal);
      delay = Math.min(delay + 300, 3000);
    }
  }

  /** The files produced by a job's `export/url` tasks. */
  static exportedFiles(job: Job): ResultFile[] {
    return (job.tasks ?? []).filter((t) => t.operation === "export/url").flatMap((t) => t.result?.files ?? []);
  }
}

export class Operations {
  constructor(private readonly client: RunConvert) {}

  /** Every input format with its output targets, optionally only one category. Public. */
  list(params: { category?: Category } = {}): Promise<OperationsCatalog> {
    return this.client.request<OperationsCatalog>("GET", "/operations", undefined, { category: params.category });
  }

  /** What `input` can be converted to, with credit costs. Public. */
  forInput(input: string): Promise<InputFormat> {
    return this.client.request<InputFormat>("GET", "/operations", undefined, { input: input.toLowerCase() });
  }

  /** The engines for `input` → `output` and the options a convert task accepts. Public. */
  forPair(input: string, output: string): Promise<PairEngines> {
    return this.client.request<PairEngines>("GET", "/operations", undefined, { input: input.toLowerCase(), output: output.toLowerCase() });
  }
}

export class Files {
  constructor(private readonly client: RunConvert) {}

  /**
   * Uploads a file to an `import/direct/upload` task (or its `upload_url`) before its
   * `upload_deadline`. The job continues on its own once the upload is received.
   */
  async upload(task: Task | string, file: FileInput, filename?: string): Promise<void> {
    const uploadUrl = typeof task === "string" ? task : task.upload_url;
    if (!uploadUrl) throw new Error("This task has no upload_url (is it an import/direct/upload task?)");
    const url = new URL(uploadUrl);
    const name = filename ?? (typeof file === "string" ? basename(file) : undefined);
    if (name) url.searchParams.set("filename", name);

    let body: BodyInit;
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream", "User-Agent": `runconvert-node/${VERSION}` };
    if (typeof file === "string") {
      headers["Content-Length"] = String((await stat(file)).size);
      body = Readable.toWeb(createReadStream(file)) as unknown as BodyInit;
    } else if (file instanceof Uint8Array || (typeof Blob !== "undefined" && file instanceof Blob)) {
      body = file as BodyInit;
    } else {
      body = Readable.toWeb(Readable.from(file as AsyncIterable<Uint8Array>)) as unknown as BodyInit;
    }
    const res = await this.client.rawFetch(url.toString(), { method: "PUT", headers, body, duplex: "half" } as RequestInit);
    if (!res.ok) throw new RunConvertError(`Upload failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`, res.status, "", undefined);
  }

  /** Downloads a result file (or a URL) into `dir`, keeping its name. Returns the local path. */
  async download(file: ResultFile | string, dir: string, filename?: string): Promise<string> {
    const url = typeof file === "string" ? file : file.url;
    const name = filename ?? (typeof file === "string" ? basename(new URL(url).pathname) : file.filename);
    await mkdir(dir, { recursive: true });
    const res = await this.client.rawFetch(url, { headers: { "User-Agent": `runconvert-node/${VERSION}` } });
    if (!res.ok || !res.body) throw new RunConvertError(`Download failed (HTTP ${res.status})`, res.status);
    const dest = join(dir, basename(name));
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
    return dest;
  }
}
