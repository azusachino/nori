# Agent authoring API

Same can accept course drafts from an external agent. The agent credential is separate from the owner's browser session and cannot approve outlines, accept modules, or record learner answers. The owner must approve the outline and accept the module in the web app.

Generate a 32-byte token and its SHA-256 hash on the server (the token is shown once by this command):

```sh
bun -e 'import { randomBytes } from "node:crypto"; const token = randomBytes(32).toString("hex"); console.log(`Token: ${token}\nSHA-256: ${new Bun.CryptoHasher("sha256").update(token).digest("hex")}`)'
```

Set `SAME_AGENT_TOKEN_HASH` to the hash and restart Same. Give the token only to your trusted agent, over a private channel. Treat it as a password; do not put it in a URL or log. Rotating or removing the configured hash and restarting revokes it. The current implementation supports one instance-wide agent credential and has no per-agent expiry or audit log.

All endpoints require `Authorization: Bearer <token>` and JSON request bodies. IDs are returned by the server:

- `POST /api/agent/courses`: `{ "title": "…", "goal": "…" }` creates a draft course.
- `GET /api/agent/courses/{id}` reads that course's title, goal and outline.
- `POST /api/agent/courses/{id}/outline`: `{ "outline": "…" }` saves a draft outline until the owner approves it.
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

The multiple-choice answer must match one option. Each module must include all three exercise types. The owner reviews and edits the draft in Same before accepting it. The current API does not yet support revising an existing module, source upload, or adding further modules.
