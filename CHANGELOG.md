# Changelog

## 0.1.0 (unreleased)

First version, following the v3 API spec:

- `convert(file | url | bytes, { to })`: upload or import, convert, wait, download in one call
- Jobs: `create`, `get`, `list`, `all`, `wait`, `cancel`, `delete`
- Files: `upload` (path, bytes or stream) and `download`
- Operations: `list`, `forInput`, `forPair` (public)
- `me()`: account and credit balance
- Webhooks: `verifySignature`, `constructEvent`
- Typed errors: `RunConvertError`, `JobFailedError`, `WaitTimeoutError`
- Retries for network errors, 429 and 5xx; a job is never created twice
- ESM and CommonJS builds with TypeScript types; Node.js 18+, no dependencies
