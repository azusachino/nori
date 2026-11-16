# Contextual tutor

The contextual tutor answers a learner's question about one accepted module lesson, using only explicitly selected exercise attempts from that module. It is learner-only, has no agent route, never executes code and never applies changes to course material.

## Context contract

`POST /api/courses/{id}/tutor`:

```json
{ "moduleId": "…", "lessonIndex": 1, "attemptIds": ["…"], "message": "Explain this attempt.", "proposal": false }
```

- `moduleId` must belong to the course and be accepted. Draft modules return 409; an unknown module returns 404.
- `lessonIndex` is a zero-based integer within that module's lessons (400 for a malformed index, 404 when out of range).
- `attemptIds` is optional, but when supplied it is the complete selection: unique UUIDs (at most 20) that belong to the selected module. Missing or other-module/other-course IDs return 404; malformed or duplicate IDs return 400.
- `message` is the learner's question, 1–4,000 characters.
- `proposal` requests a reviewable proposal instead of ordinary tutoring (below).

The model receives exactly:

1. The selected lesson's title and body.
2. The selected attempt records: id, exercise ID, exercise index, exercise prompt, learner answer, existing feedback, correctness and owner correction.
3. Prior tutor turns for the same module and lesson, newest last, subject to the context limit.

No course source text, other lessons, unselected attempts or other courses are sent. The system prompt says to use only this supplied material, to state when the lesson does not cover something, not to claim source or citation verification, and never to execute code.

Exercises are module-level: they are not linked to an individual lesson. The tutor therefore never infers which attempts are related to the selected lesson; the learner explicitly chooses them.

The response `context` discloses what was supplied: module and lesson IDs/titles, `lessonText`, every selected attempt with its text, `sourceIds: []`, `contextLimit` (120,000), `contextChars` actually sent, `historyTurnsIncluded`, `historyTurnsDropped`, and `history` with the ID, role and exact text of every prior turn included. Prior turns may repeat material discussed earlier even when the current attempt selection changes.

## Limits and failure

- If the fixed system prompt, supplied context and question exceed 120,000 characters, the request returns 400 naming the limit and the provider is not called.
- Prior lesson turns are added newest-first while they fit; older turns are dropped and reported in `historyTurnsDropped`.
- Provider timeout is 90 seconds and provider/status/invalid-response failures return 502. No turn is stored on failure, and previous turns remain intact.

## Persistence and concurrency

- `tutor_turns` stores user and assistant turns per course, module and lesson index with the exact disclosed context JSON and timestamp.
- Both turn rows are inserted in one transaction only after a successful model response. A failed or rejected request writes nothing.
- `GET /api/courses/{id}/tutor?moduleId=…&lessonIndex=…` returns `{ moduleId, lessonIndex, lessonTitle, contextLimit, revision, turns, proposals }` for that lesson only, including each turn's stored context. It survives restart and keeps lessons isolated.
- `revision` is the number of stored turn rows for that lesson. A request records the revision before the model call and re-checks it inside the post-model transaction; a concurrent turn returns 409 rather than silently appending to reordered history.

## Reviewable proposals

With `proposal: true`, the tutor reply is stored as plain text in `tutor_proposals`, separate from modules, drafts and attempts. The response includes `proposal: { id, content, createdAt, draft }`, where `draft` is the current unaccepted draft's `{ id, position, contentHash }` or `null` when no draft exists.

- An optional `expectedDraftContentHash` must match the current unaccepted draft before the model call and is re-checked inside the post-model transaction. A changed or missing draft returns 409 and stores no proposal.
- A proposal is never applied automatically. It does not modify accepted modules, drafts, exercise attempts or assessment results. Applying an edit remains the existing `save-module` and `accept` workflow, where the learner edits and accepts a draft explicitly.

## Errors

| Case | Result |
| --- | --- |
| Unknown module / lesson | 404 |
| Malformed module/lesson/attempt/message fields | 400 |
| Draft (not accepted) module | 409 |
| Attempt outside the selected module or course | 404 |
| Duplicate attempt IDs | 400 |
| Selected context over 120,000 characters | 400, provider not called |
| Provider error, timeout or invalid response | 502, no turns stored |
| Conversation changed during the model call | 409, no turns stored |
| Proposal draft changed during the model call | 409, no proposal stored |

The existing local host/origin checks still gate these learner writes, and provider credentials remain server-side.

## Tests and limits

Automated tests use a captured mock provider and an injected clock:

- exact prompt and disclosure, including lesson/attempt IDs and text, prior turn IDs/text and no source/other-attempt/other-lesson leakage;
- per-lesson persistence and isolation across a database restart;
- missing, mismatched, malformed and stale references;
- provider failure with unchanged prior history, modules, drafts and attempts;
- proposal persistence, stale-draft rejection, draft change during generation and the no-draft case;
- concurrent conversation revision rejection;
- over-budget rejection without a provider call.

These are backend tests against a deterministic HTTP fixture. A real provider, real-model answer quality, browser/desktop/mobile journey and route-origin browser checks were not exercised here; the UI is not integrated yet. Source citations are not verified. Written and code feedback remains advisory.
