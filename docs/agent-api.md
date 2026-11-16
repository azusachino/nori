# Agent authoring API

Nori accepts course drafts from trusted local agents. It has no authentication: any local process with access to the server can read courses, approve material and submit learner work through the browser API. The agent routes provide a draft workflow, not a security boundary. Do not expose Nori to an untrusted network or agent.

Agent POST requests require the `X-Nori-Agent: 1` header and JSON request bodies; this header prevents ordinary cross-origin browser forms from invoking the agent API. IDs are returned by the server.

## Course and outline

- `POST /api/agent/courses`: `{ "title": "…", "goal": "…" }` creates a draft course.
- `GET /api/agent/courses/{id}` reads that course's title, goal and outline. It returns:
  - `modules`: ordered module metadata, `[{ id, position, accepted, acceptedAt, contentHash }]`. An unaccepted draft also includes `content`; accepted modules stay metadata-only so the draft workflow matches the earlier API.
  - `modulesHash`: a hash of the ordered module IDs, positions, content hashes and acceptance state.
  - `draft`: the single unaccepted module, `{ id, position, content, contentHash }`, or `null`.
- `POST /api/agent/courses/{id}/outline`: `{ "outline": "…" }` saves a draft outline until the owner approves it. To revise an existing outline, also provide its exact current text in `expectedOutline`; a stale revision returns 409.

## Modules

Modules are ordered by a server-assigned `position` starting at 1. At most one unaccepted draft exists per course, and accepted modules are immutable through this API.

The original first-module route is unchanged:

- `POST /api/agent/courses/{id}/module` creates module 1 after outline approval, or revises it while it is the only draft. It returns 409 once module 1 is accepted, and it never edits a later module. Existing clients can keep using it.

For later modules, use the additive collection routes:

- `GET /api/agent/courses/{id}/modules`: `{ "modules": [...], "modulesHash": "…" }`, in the same shape as `GET /api/agent/courses/{id}`.
- `POST /api/agent/courses/{id}/modules` with `{ "content": { … } }` creates the next draft module. It requires an approved outline and a latest module that is already accepted; it returns 409 while a draft is pending. A course with no modules accepts this call as module 1. The response is `201` with `{ "module": { … }, "modulesHash": "…" }`.
- To revise a draft, send `{ "content": { … }, "moduleId": "…", "expectedContentHash": "…" }` to the same route. A stale `expectedContentHash`, a revision of an accepted module, or a missing module returns 409/404 rather than overwriting anything. The response is `200` with `{ "module": { … }, "modulesHash": "…" }`.
- An optional `expectedModulesHash` guards either operation against another writer changing the ordered modules, including a draft becoming accepted; a stale value returns 409.

A module body uses the same validated shape as before:

```json
{
  "content": {
    "title": "First principles",
    "lessons": [{ "title": "Foundations", "body": "Explain the idea." }],
    "exercises": [
      { "type": "multiple_choice", "prompt": "Choose one.", "options": ["A", "B"], "answer": "A", "explanation": "Why A is correct." },
      { "type": "written", "prompt": "Explain.", "options": [], "answer": "Reference answer.", "explanation": "What to look for." },
      { "type": "code", "prompt": "Write a function.", "options": [], "answer": "Reference solution.", "explanation": "What to look for." }
    ]
  }
}
```

The multiple-choice answer must match one option. Each module must include all three exercise types. The owner reviews and edits drafts in Nori before accepting them. When the owner generates a later module, the model receives the requested module number, the approved outline and the titles of accepted modules; module generation never rewrites an accepted module.

## Learner routes and compatibility

The learner routes gain `modules` (ordered visible modules), `modulesHash` and `module` (the first module, kept as a compatibility alias) on `GET /api/courses/{id}`. `POST /api/courses/{id}/modules` generates the next module after the latest one is accepted. Generation compares the ordered module IDs, positions, content and acceptance state with the pre-request snapshot and returns 409 if anything changed while the model was running, rather than saving material prompted for the wrong ordinal.

Existing learner calls that omit `moduleId` keep targeting module 1: `save-module`, `accept`, `answer` and `feedback`. Later modules require `moduleId` in the request body. `POST /api/courses/{id}/module` still creates only module 1 and returns 409 when it already exists. This means an old client cannot accept or answer a later module by accident. `moduleId` must belong to the course.

The current API does not yet support source upload through the agent routes. Source upload remains a learner-route feature. Assessments and the contextual tutor are learner-only; this agent API does not expose learning activities.
