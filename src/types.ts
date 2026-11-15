/**
 * Types for the RunConvert v3 API, following docs/openapi/runconvert-v3.yaml in the
 * backend repo. Objects can carry more fields than listed here; they are kept as-is.
 */

export type JobStatus = "waiting" | "processing" | "finished" | "error";
export type TaskStatus = JobStatus;
export type Category =
  | "video" | "audio" | "image" | "document" | "ebook" | "presentation"
  | "spreadsheet" | "vector" | "cad" | "archive" | "font";

/** The name of the upstream task, or several names (merge, combine, zip). */
export type TaskInput = string | string[];

export interface ImportUrlTask {
  operation: "import/url";
  /** Public http(s) URL of the file. */
  source_url: string;
  ignore_error?: boolean;
}

export interface ImportUploadTask {
  operation: "import/direct/upload";
  ignore_error?: boolean;
}

export interface ConvertTask {
  operation: "convert";
  input: TaskInput;
  input_format: string;
  output_format: string;
  preferred_engine?: string;
  ignore_error?: boolean;
  /** Engine options go directly on the task, e.g. `audioBitrate: "192k"` (see operations.forPair). */
  [option: string]: unknown;
}

export interface ExportUrlTask {
  operation: "export/url";
  input: TaskInput;
  /** Bundle every input file into one ZIP. */
  archive?: boolean;
  /** ZIP only when there is more than one file. */
  archive_multiple?: boolean;
  /** ZIP name without .zip. */
  archive_name?: string;
  ignore_error?: boolean;
}

export type TaskDefinition = ImportUrlTask | ImportUploadTask | ConvertTask | ExportUrlTask;

export interface JobCreateParams {
  /** Named task definitions: letters, digits, `-` or `_`, up to 64 characters. */
  tasks: Record<string, TaskDefinition>;
  tag?: string;
  metadata?: Record<string, unknown>;
}

export interface ResultFile {
  filename: string;
  /** Temporary download link. */
  url: string;
  size?: number;
  created_at?: string;
}

export interface Task {
  id?: string;
  job_id?: string;
  name: string;
  operation: string;
  status: TaskStatus;
  percent?: number;
  message?: string;
  engine?: string;
  engine_version?: string;
  credits?: number;
  ignore_error?: boolean;
  input?: string[];
  /** `import/direct/upload` only: PUT the file here (see files.upload). */
  upload_url?: string;
  upload_deadline?: string;
  result?: { files?: ResultFile[] };
  /** On error, the broad category (INVALID_DATA, PROCESSING_ERROR, …). */
  code?: string;
  /** On error, the exact, stable cause (e.g. INPUT_DRM_MUSIC). */
  reason?: string;
  reason_params?: Record<string, unknown>;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
  expires_at?: string | null;
  updated_at?: string;
  [field: string]: unknown;
}

export interface Job {
  id: string;
  status: JobStatus;
  tag?: string | null;
  metadata?: Record<string, unknown>;
  credits_used?: number;
  credit_type?: string;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
  expires_at?: string | null;
  updated_at?: string;
  /** Present when the job was fetched with tasks (the SDK's default). */
  tasks?: Task[];
  [field: string]: unknown;
}

export interface ListMeta {
  page?: number;
  per_page?: number;
  total?: number;
  total_pages?: number;
}

export interface Page<T> {
  data: T[];
  meta: ListMeta;
}

export interface Me {
  user?: { email?: string; full_name?: string };
  team?: { name?: string };
  api_key?: { name?: string } | null;
  credits?: {
    mode?: "daily" | "wallet";
    daily_limit?: number;
    daily_remaining?: number;
    total_remaining?: number;
  } | null;
  [field: string]: unknown;
}

export interface OutputTarget {
  format: string;
  category?: Category;
  engine?: string;
  /** Credits per input file. */
  credits: number;
  browser_capable?: boolean;
  browser_max_bytes?: number;
  browser_max_seconds?: number;
}

export interface InputFormat {
  format: string;
  category?: Category;
  outputs: OutputTarget[];
}

export interface OperationsCatalog {
  categories: Category[];
  formats: InputFormat[];
}

export interface EngineOption {
  name: string;
  type: string;
  description?: string;
  supported_values?: unknown[];
}

export interface Engine {
  name: string;
  credits: number;
  options?: EngineOption[];
  browser_capable?: boolean;
  browser_max_bytes?: number;
  browser_max_seconds?: number;
}

export interface PairEngines {
  input: string;
  output: string;
  engines: Engine[];
}

export type WebhookEventType =
  | "job.created" | "job.processing" | "job.finished" | "job.error"
  | "task.finished" | "task.error";

export interface WebhookEvent {
  event: WebhookEventType;
  job?: Job;
  task?: Task;
}
