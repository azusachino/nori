# Nori sidecar API (v1)

The Nori sidecar is a headless Bun HTTP server backed by `bun:sqlite` and Drizzle ORM ([src/lib/server/schema.ts](../src/lib/server/schema.ts), [drizzle/0000_sidecar_init.sql](../drizzle/0000_sidecar_init.sql)) that stores live learner state and owns the OpenAI-compatible LLM boundary for static course sites (such as Apricot). It is single-owner, personal-use only, and requires no authentication; keep it bound to loopback (`127.0.0.1`) or private to your tailnet and never expose it to the public internet.

## Running the sidecar

```sh
make sidecar
# or with Podman / Docker:
podman build -t nori-sidecar:0.0.1 -f Containerfile .
podman run --rm -p 127.0.0.1:3001:3001 -v nori-data:/data nori-sidecar:0.0.1
```

Environment variables:

- `NORI_HOST` — bind address (default `127.0.0.1`; `0.0.0.0` inside `Containerfile`).
- `NORI_PORT` — listen port (default `3001`).
- `NORI_BASE_PATH` — URL mount prefix (default `/api/nori`; set to `""` or `"/"` when a reverse proxy strips `/api/nori`).
- `NORI_DATABASE_PATH` — SQLite path (default `.data/nori.sqlite`; `/data/nori.sqlite` inside `Containerfile`).
- `NORI_LLM_BASE_URL`, `NORI_LLM_MODEL`, `NORI_LLM_API_KEY` — OpenAI-compatible provider settings, kept strictly server-side.

## External content keys

All sidecar endpoints address content using canonical external identifiers:

- `courseKey`: `<track>/<course>` without a leading `courses/` prefix (e.g., `ai/stanford-cs229-ml`).
- `lessonKey`: `NN-slug` without `.md` or path separators (e.g., `01-exponential-families-and-glms`); optional (defaults to `""`) for course-level banks.
- `exerciseKey`: stable exercise identifier within the lesson or bank (e.g., `q-1`).
- `contentHash`: SHA-256 hex digest computed by the sidecar over the canonicalized `exerciseSnapshot` (`{ type, prompt, options, answer, explanation }`).

## Endpoints

All responses are JSON. `GET` endpoints set `Cache-Control: no-store`.

### Health

- `GET <basePath>/v1/health` → `{ "ok": true, "apiVersion": 1, "llmConfigured": true }`

### Practice

- `GET <basePath>/v1/practice?courseKey=<key>[&lessonKey=<key>][&exerciseKey=<key>]` — lists recorded `practice_attempts` in chronological order (`created_at ASC`).
- `POST <basePath>/v1/practice/attempts` — records an attempt immediately (64 KB body limit), grading `multiple_choice` deterministically (`correct: 1 | 0`) and storing `written`/`code` as `grading: "unscored"`, `correct: null`.
- `POST <basePath>/v1/practice/attempts/{attemptId}/feedback` — requests advisory LLM feedback (`advisory: true`) for a `written` or `code` attempt outside SQLite transactions with pre/post `version` optimistic concurrency (`409` on conflict, `502` on provider failure).
- `POST <basePath>/v1/practice/attempts/{attemptId}/correct` — records or updates `ownerNote` with `expectedVersion` (`409` on conflict).

### Assessments

- `GET <basePath>/v1/assessments?courseKey=<key>` — lists assessments for a course (auto-finalizing any expired active timed assessments).
- `POST <basePath>/v1/assessments` — creates a `timed` (`durationSeconds`: 60–28800) or `untimed` assessment from 1–100 client-supplied exercise snapshots (256 KB body limit). Reference answers and explanations remain hidden until finalization.
- `GET <basePath>/v1/assessments/{assessmentId}` — returns assessment detail with `serverNow` and `remainingMs`.
- `POST <basePath>/v1/assessments/{assessmentId}/start` — activates a planned assessment and sets absolute `deadlineAt`.
- `POST <basePath>/v1/assessments/{assessmentId}/answers` — saves `{ itemId, answer, expectedVersion? }` before `deadlineAt`.
- `POST <basePath>/v1/assessments/{assessmentId}/submit` — freezes results (`submittedAt = finalizedAt`).
- `POST <basePath>/v1/assessments/{assessmentId}/feedback` — requests post-finalization advisory LLM feedback on an unscored item.
- `POST <basePath>/v1/assessments/{assessmentId}/correct` — saves an owner correction note on a finalized item.

### Contextual Tutor

- `GET <basePath>/v1/tutor?courseKey=<key>&lessonKey=<key>` — returns `{ courseKey, lessonKey, contextLimit: 120000, revision, turns }`.
- `POST <basePath>/v1/tutor` — accepts `{ courseKey, lessonKey, lessonTitle, lessonText, attemptIds?, message }` (256 KB body limit), validates that all `attemptIds` belong to `(courseKey, lessonKey)`, frames lesson text and attempts as untrusted data, deduplicates lesson prose by SHA-256 in `sidecar_tutor_lessons`, enforces the 120,000-character context budget, and checks turn `revision` (`409` on concurrent write).
