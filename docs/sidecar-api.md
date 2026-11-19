# Nori sidecar API (v1)

The Nori sidecar is a headless Bun HTTP server backed by `bun:sqlite` that stores live learner practice state and owns the OpenAI-compatible LLM boundary for static course sites (such as Apricot). It is single-owner, personal-use only, and requires no authentication; keep it bound to loopback (`127.0.0.1`) or private to your tailnet and never expose it to the public internet.

## Running the sidecar

```sh
make sidecar
# or
bun run sidecar
```

Environment variables (all `NORI_*`, with `SAME_*` fallback where applicable):

- `NORI_HOST` — bind address (default `127.0.0.1`).
- `NORI_PORT` — listen port (default `3001`).
- `NORI_BASE_PATH` — URL mount prefix (default `/api/nori`; set to `""` or `"/"` when a reverse proxy strips `/api/nori`).
- `NORI_DATABASE_PATH` — SQLite path (default `.data/nori.sqlite`).
- `NORI_LLM_BASE_URL`, `NORI_LLM_MODEL`, `NORI_LLM_API_KEY` — OpenAI-compatible provider settings, kept strictly server-side.

## External content keys

All sidecar endpoints address content using canonical external identifiers rather than Nori-created course UUIDs:

- `courseKey`: `<track>/<course>` without a leading `courses/` prefix (e.g., `ai/stanford-cs229-ml`).
- `lessonKey`: `NN-slug` without `.md` or path separators (e.g., `01-exponential-families-and-glms`); optional (defaults to `""`) for course-level banks.
- `exerciseKey`: stable exercise identifier within the lesson or bank (e.g., `ex-01`).
- `contentHash`: SHA-256 hex digest computed by the sidecar over the canonicalized `exerciseSnapshot` (`{ type, prompt, options, answer, explanation }`). If the client supplies `contentHash`, the sidecar verifies it matches and returns `400` on mismatch.

## Endpoints (Slice 1: Health & Practice)

All responses are JSON. `GET` endpoints set `Cache-Control: no-store`.

### `GET <basePath>/v1/health`

Returns sidecar liveness, API version, and whether an LLM provider is configured:

```json
{ "ok": true, "apiVersion": 1, "llmConfigured": true }
```

### `GET <basePath>/v1/practice?courseKey=<key>[&lessonKey=<key>][&exerciseKey=<key>]`

Lists recorded `practice_attempts` in chronological order (`created_at ASC`). `courseKey` is required; `lessonKey` and `exerciseKey` are optional filters.

### `POST <basePath>/v1/practice/attempts`

Records a learner attempt immediately (body limit: 64 KB), decoupling persistence from LLM availability:

```json
{
  "courseKey": "ai/stanford-cs229-ml",
  "lessonKey": "01-exponential-families-and-glms",
  "exerciseKey": "ex-01",
  "exerciseSnapshot": {
    "type": "written",
    "prompt": "Why does the canonical link simplify the gradient?",
    "options": [],
    "answer": "The natural parameter equals theta^T x...",
    "explanation": "Derived from the log-partition function."
  },
  "answer": "Because eta = theta^T x cancels the chain-rule Jacobian."
}
```

- `multiple_choice`: `answer` must match one of `exerciseSnapshot.options` exactly (preserving surrounding spaces). Stored with `grading: "deterministic"` and `correct: 1` or `0`.
- `written` / `code`: trimmed non-empty answer stored with `grading: "unscored"` and `correct: null`. Code is never executed.
- Returns `201` with `{ "attempt": { ... } }` (`version: 0`).

### `POST <basePath>/v1/practice/attempts/{attemptId}/feedback`

Requests advisory LLM feedback for a `written` or `code` attempt. Optional body: `{ "expectedVersion": 0 }`.

- Rejects `multiple_choice` attempts with `409`.
- Runs the model call outside any SQLite transaction with untrusted-data prompt framing.
- Provider errors return `502` without modifying the attempt.
- Re-checks `version` inside the post-model transaction; concurrent writes return `409` with the current `attempt` rather than overwriting.
- On success, stores `feedback`, sets `advisory: true`, increments `version`, and returns `200` with `{ "attempt": { ... } }`.

### `POST <basePath>/v1/practice/attempts/{attemptId}/correct`

Saves or updates `ownerNote` on an attempt:

```json
{ "ownerNote": "Missed the dispersion parameter.", "expectedVersion": 1 }
```

- Enforces optimistic concurrency when `expectedVersion` is supplied (`409` on mismatch).
- Increments `version` and returns `200` with `{ "attempt": { ... } }`.

## Storage and backups

`practice_attempts` is created idempotently during `migrate()` alongside existing tables and does not modify legacy course/module/attempt tables. Backups continue to use SQLite online backup (`VACUUM INTO`) as documented in [backup.md](backup.md).
