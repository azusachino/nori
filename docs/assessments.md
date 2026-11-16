# Assessments

Assessments are a separate, learner-only activity built from accepted course modules. They are not part of the agent API and do not rewrite module content or exercise attempts. Code is never executed.

## Model and scope

An assessment snapshots exercises from one or more accepted modules:

- `assessments`: title, mode (`timed` or `untimed`), duration, status, scope summary, timestamps and a `version`.
- `assessment_items`: an ordered snapshot of each chosen exercise (type, prompt, options, reference answer, explanation) plus its source module.
- `assessment_answers`: answers saved while the assessment is active.
- `assessment_results`: frozen results created once when the assessment is submitted or expires.

Create an assessment with `POST /api/courses/{id}/assessments`:

```json
{ "title": "Midpoint check", "mode": "timed", "durationSeconds": 1800, "moduleIds": ["…", "…"], "exerciseIds": ["…"] }
```

`moduleIds` must all belong to the course and be accepted; `exerciseIds` is optional and selects a subset. Selected modules are snapshotted in course order by module position, ignoring the order of `moduleIds` in the request; exercises follow their order within each module. The planned detail already shows the scope (module titles, lesson and exercise counts, prompts and options) but no reference answers or explanations. `GET /api/courses/{id}/assessments` lists summaries; `GET /api/courses/{id}/assessments/{assessmentId}` returns the detail.

The exercise model is module-level: exercises belong to a module, not to an individual lesson. An assessment can therefore cover modules that contain several lessons, and the scope reports each module's lesson and exercise counts, but it cannot claim question-level lesson attribution. No lesson ID is stored per item. Exercise IDs are only required to be unique within a module, so two accepted modules may contain the same exercise UUID; assessment items are unique by `(assessment_id, module_id, exercise_id)` and both may be included.

## Lifecycle

Statuses are `planned → active → submitted` or `planned → active → expired`.

- `POST .../{assessmentId}/start`: activates a planned assessment. For a timed assessment, `startedAt` and `deadlineAt = startedAt + durationSeconds * 1000` are stored as absolute epoch milliseconds. Starting an active assessment resumes it with the same timestamps; starting a finalized assessment returns 409.
- `POST .../{assessmentId}/answers` with `{ itemId, answer, expectedVersion? }`: saves an answer while active. A multiple-choice answer must match one stored option exactly, including surrounding spaces; free-text answers are trimmed.
- `POST .../{assessmentId}/submit` with `{ expectedVersion? }`: explicit submission. It freezes results and sets `submittedAt` and `finalizedAt` to the submit time.

Answers and submission are rejected after finalization. Advisory feedback and owner corrections remain available during review (below).

## Expiry semantics

A timed assessment expires when the server handles any read or write at or after `deadlineAt`. The check, finalization and answer/submit write happen in one SQLite transaction, so an answer cannot land after the deadline.

- No explicit submission occurred, so **`submittedAt` stays `null`** on expiry.
- `deadlineAt` is the effective expiry instant. `finalizedAt` is when the server first observed and recorded finalization; it is not backdated.
- Finalization sets `status = 'expired'`, creates one result per item from the answers saved at that moment, and increments `version` exactly once. Later reads or restarts do not re-finalize; `finalizedAt`, results and `version` are stable.
- Because the deadline is absolute, restarting the server does not restart, extend or recompute the timer. A restart after the deadline finalizes on the next request with the stored `deadlineAt`.
- `remainingMs` is `max(0, deadlineAt - now)` while active and timed; it is `null` for untimed, planned or finalized assessments. `serverNow` is returned with every detail so a client can render the deadline without trusting its own clock.

An expired assessment is reviewed through the normal `GET` detail. Writes to answers, start and submit return 409 with the finalized assessment in the response body.

## Results and advisory feedback

Finalization computes:

- Multiple choice deterministically: `correct` is `1` or `0`, comparing the saved answer with the stored option exactly. An unanswered multiple-choice item has `answer: null, correct: 0`.
- Written and code items are `grading: 'unscored'`, with `correct: null`. They are never given a fabricated score, even when unanswered. Reference answers and explanations become visible only after finalization.

The detail summary contains counts (`answeredCount`, `deterministicTotal`, `deterministicCorrect`, `deterministicIncorrect`, `unscoredCount`), not a percentage or mastery claim. A score is not persisted as mastery.

Advisory feedback is optional and explicitly labelled:

- `POST .../{assessmentId}/feedback` with `{ itemId, expectedVersion? }` calls the configured model for a written or code item after finalization. The stored result has `advisory: true`, `correct: null` and the model text in `feedback`. The model call happens outside SQLite transactions.
- `POST .../{assessmentId}/correct` with `{ itemId, note, expectedVersion? }` stores the owner's correction in `ownerNote`.
- Both are allowed after submission or expiry because they annotate the review, not the assessment answers. Multiple-choice items reject model feedback.

Every mutation increments `version`. Requests may send `expectedVersion`; a mismatch returns 409. Advisory feedback compares the version observed before the model call with the version at write time, so a correction or another write that lands while the model is running returns 409 instead of overwriting it.

## Compatibility and tests

Assessments use new tables only. Existing modules, accepted module content and exercise attempts are untouched. The migration adds the tables on an existing database and is a no-op on restart. An older assessment-items table with exercise-only uniqueness is rebuilt in a transaction to module-scoped uniqueness, preserving item IDs, positions and the answer/result references; a failed rebuild rolls back and leaves the previous table intact.

Automated checks use an injected clock (`createLearnerApi(database, () => clock)`) and cover: multi-module scope and subset snapshots, the same exercise UUID appearing in two modules, legacy assessment-item migration/reopen/rollback with preserved IDs and answer/result references, unaccepted-module rejection, deadline visibility, answer save and resume after reopening the database, the last second before the deadline versus the exact boundary, explicit submission, untimed assessments that never expire, expiry across restart with `submittedAt = null` and a stable observed `finalizedAt`, idempotent finalization, stale-version conflicts, frozen writes after finalization, advisory feedback/correction labels, late-feedback conflict after a concurrent write, and preserved module/attempt rows.

Advisory feedback tests use a deterministic HTTP model fixture, not a real provider. Expiry tests use a controlled clock, not a wall-clock wait. No real-model assessment review, browser journey, or deployed restart was exercised by these backend tests. The assessment learner interface is not integrated yet; the separately owned UI and desktop/mobile journey must be integrated and verified by the UI owner before assessments are presented as a complete user-facing feature.
