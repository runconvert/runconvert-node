import type { Job, Task } from "./types.js";

/**
 * An error response from the API: `{ success: false, error: { code, message } }`.
 * `code` is machine-readable (e.g. BILLING_INSUFFICIENT_CREDITS); new codes can appear,
 * so branch on `status` for anything you don't recognise.
 */
export class RunConvertError extends Error {
  override readonly name: string = "RunConvertError";
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got a response. */
    readonly status: number,
    /** API error code, e.g. VALIDATION_ERROR. Empty when the API sent none. */
    readonly code: string = "",
    /** The raw response body, when there was one. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** The job finished with status `error`. `task` is the first failed task (code, reason, message). */
export class JobFailedError extends RunConvertError {
  override readonly name = "JobFailedError";
  constructor(readonly job: Job, readonly task?: Task) {
    super(task?.message || `Job ${job.id} failed`, 0, task?.code ?? "", job);
  }
}

/** `jobs.wait` gave up before the job reached `finished` or `error`. */
export class WaitTimeoutError extends RunConvertError {
  override readonly name = "WaitTimeoutError";
  constructor(readonly job: Job, timeoutMs: number) {
    super(`Job ${job.id} still ${job.status} after ${Math.round(timeoutMs / 1000)}s`, 0, "WAIT_TIMEOUT", job);
  }
}
