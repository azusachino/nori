# Agent authoring API

Nori accepts course drafts from trusted local agents. It has no authentication: any local process with access to the server can read courses, approve material and submit learner work through the browser API. The agent routes provide a draft workflow, not a security boundary. Do not expose Nori to an untrusted network or agent.

Agent POST requests require the `X-Nori-Agent: 1` header and JSON request bodies; this header prevents ordinary cross-origin browser forms from invoking the agent API. IDs are returned by the server:

- `POST /api/agent/courses`: `{ "title": "…", "goal": "…" }` creates a draft course.
- `GET /api/agent/courses/{id}` reads that course's title, goal and outline; for an unaccepted module it also returns `draft.content` and `draft.contentHash`.
- `POST /api/agent/courses/{id}/outline`: `{ "outline": "…" }` saves a draft outline until the owner approves it. To revise an existing outline, also provide its exact current text in `expectedOutline`; a stale revision returns 409.
- After outline approval, `POST /api/agent/courses/{id}/module` creates the first draft module:

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

The multiple-choice answer must match one option. Each module must include all three exercise types. The owner reviews and edits the draft in Nori before accepting it. To revise an existing draft, read it first, then send the changed `content` and the returned `expectedContentHash` to the same module endpoint. A stale hash returns 409 rather than overwriting changes. The current API does not yet support source upload or adding further modules.
