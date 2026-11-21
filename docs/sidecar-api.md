# Nori sidecar API (v1)

The Nori sidecar is a headless Bun HTTP server backed by `bun:sqlite` and Drizzle ORM ([src/lib/server/schema.ts](../src/lib/server/schema.ts), migrations in [drizzle/](../drizzle/)) that stores live learner state and owns the OpenAI-compatible LLM boundary for static course sites (such as Apricot). It is single-owner, personal-use only, and requires no authentication; keep it bound to loopback (`127.0.0.1`) or private to your tailnet and never expose it to the public internet.

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

## Storage

The sidecar opens SQLite in WAL mode (switched only if the file is not already WAL), with `synchronous = NORMAL` (durable across process crashes; a power loss can drop the last transactions), `busy_timeout = 5000` (a concurrent writer such as a backup or the digest CLI waits up to 5 s instead of failing), and foreign keys on. Migrations in `drizzle/` apply on startup.

## List views

`GET /v1/practice`, `GET /v1/review` and `GET /v1/assessments` accept `view=full` (default, the v1 shape below) or `view=summary`, which returns only what the SDK islands render; any other value is a `400`. The default shapes are unchanged, so existing clients keep working. Fetch the full record on demand: `GET /v1/practice/attempts/{attemptId}` or `GET /v1/assessments/{assessmentId}`.

- Practice summary: each attempt drops `exerciseSnapshot` and `feedback` and adds `exerciseType` and `hasFeedback`.
- Review summary: each item's `latestAttempt` is `{ id, contentHash, exerciseType, prompt, options, answer, correct, grading, ownerNote, createdAt }`; no reference answer, explanation or feedback.
- Assessment summary: each assessment drops `items`; the header fields, `remainingMs` and `summary` counts are the same as the full view.

## External content keys

All sidecar endpoints address content using canonical external identifiers:

- `courseKey`: `<track>/<course>` without a leading `courses/` prefix (e.g., `ai/stanford-cs229-ml`).
- `lessonKey`: `NN-slug` without `.md` or path separators (e.g., `01-exponential-families-and-glms`); optional (defaults to `""`) for course-level banks.
- `exerciseKey`: stable exercise identifier within the lesson or bank (e.g., `q-1`).
- `contentHash`: SHA-256 hex digest computed by the sidecar over the canonicalized `exerciseSnapshot` (`{ type, prompt, options, answer, explanation }`).

## Endpoints

All responses are JSON. `GET` endpoints set `Cache-Control: no-store`.

### Health

- `GET <basePath>/v1/health` → `{ "ok": true, "apiVersion": 1, "llmConfigured": true, "features": ["progress", "assessment-sample"] }`. `features` lists optional endpoints added within v1; a client checks it before calling one, and treats a missing `features` (an older sidecar) as none.

### Practice

- `GET <basePath>/v1/practice?courseKey=<key>[&lessonKey=<key>][&exerciseKey=<key>][&view=summary]` — lists recorded `practice_attempts` in chronological order (`created_at ASC`).
- `GET <basePath>/v1/practice/attempts/{attemptId}` — returns one attempt in full (`{ attempt }`, `404` if unknown).
- `POST <basePath>/v1/practice/attempts` — records an attempt immediately (64 KB body limit), grading `multiple_choice` deterministically (`correct: 1 | 0`) and storing `written`/`code` as `grading: "unscored"`, `correct: null`. An optional client-generated `id` (UUID) makes the call idempotent: repeating it returns the stored attempt (`200`) instead of inserting a second one (`409` if that id belongs to another exercise or a different answer).
- `POST <basePath>/v1/practice/attempts/{attemptId}/feedback` — requests advisory LLM feedback (`advisory: true`) for a `written` or `code` attempt outside SQLite transactions with pre/post `version` optimistic concurrency (`409` on conflict, `502` on provider failure).
- `POST <basePath>/v1/practice/attempts/{attemptId}/correct` — records or updates `ownerNote` with `expectedVersion` (`409` on conflict).

### Assessments

- `GET <basePath>/v1/assessments?courseKey=<key>[&view=summary]` — lists assessments for a course, newest first (auto-finalizing any expired active timed assessments).
- `POST <basePath>/v1/assessments` — creates a `timed` (`durationSeconds`: 60–28800) or `untimed` assessment from 1–100 client-supplied exercise snapshots (1 MB body limit). Reference answers and explanations remain hidden until finalization.
  - Sampling (feature `assessment-sample`): with `sample: { count, strategy?, seed? }`, `items` is a pool of up to 500 exercises, each `(lessonKey, exerciseKey)` at most once, and the sidecar draws `count` (1–100; the whole pool if smaller) without replacement, in draw order. `strategy` is `random` (default, uniform) or `weak`, which weights each exercise by its recall state in this course: incorrect 4, due 3, never practised 2, practised and not due 1. `seed` is an integer 0–4294967295; the sidecar picks one if it is omitted. The same seed, pool order and (for `weak`) practice history draw the same items. The response adds `sample: { strategy, seed, count, poolSize }`; the seed is not stored with the assessment. Without `sample`, the request and response are unchanged.
- `GET <basePath>/v1/assessments/{assessmentId}` — returns assessment detail with `serverNow` and `remainingMs`.
- `POST <basePath>/v1/assessments/{assessmentId}/start` — activates a planned assessment and sets absolute `deadlineAt`.
- `POST <basePath>/v1/assessments/{assessmentId}/answers` — saves `{ itemId, answer, expectedVersion? }` before `deadlineAt`.
- `POST <basePath>/v1/assessments/{assessmentId}/submit` — freezes results (`submittedAt = finalizedAt`).
- `POST <basePath>/v1/assessments/{assessmentId}/feedback` — requests post-finalization advisory LLM feedback on an unscored item.
- `POST <basePath>/v1/assessments/{assessmentId}/correct` — saves an owner correction note on a finalized item.

### Contextual Tutor

- `GET <basePath>/v1/tutor?courseKey=<key>&lessonKey=<key>` — returns `{ courseKey, lessonKey, contextLimit: 120000, revision, turns }`.
- `POST <basePath>/v1/tutor` — accepts `{ courseKey, lessonKey, lessonTitle, lessonText, attemptIds?, message }` (256 KB body limit), validates that all `attemptIds` belong to `(courseKey, lessonKey)`, frames lesson text and attempts as untrusted data, deduplicates lesson prose by SHA-256 in `sidecar_tutor_lessons`, enforces the 120,000-character context budget, and checks turn `revision` (`409` on concurrent write).

### Recall

- `GET <basePath>/v1/review[?courseKey=<key>][&onlyDue=1][&view=summary]` — the spaced-recall queue, one item per tracked exercise, computed in SQLite and ordered by reason (`incorrect`, `has_takeaway_note`, `due_for_recall`, `scheduled`) then `dueAt`. Returns `{ courseKey, serverNow, summary: { totalTracked, dueNow, incorrectCount, scheduledCount }, items }`.
- `GET <basePath>/v1/digest[?courseKey=<key>]` — a Markdown recall digest with stats.

### Progress

- `GET <basePath>/v1/progress?courseKey=<key>` (feature `progress`) — per-lesson progress, aggregated in SQLite over the review queue's per-exercise scoring, so `exercisesDue` agrees with `/v1/review`. Returns `{ courseKey, serverNow, totals, lessons }`. Each lesson is `{ lessonKey, exercisesAttempted, exercisesCorrect, exercisesIncorrect, exercisesDue, attempts, lastActivityAt }`, ordered by `lessonKey`. `totals` has the same counts without `lessonKey`. Correct and incorrect count exercises whose latest attempt was graded that way; open-ended exercises count as attempted only. Only lessons with attempts are listed.
