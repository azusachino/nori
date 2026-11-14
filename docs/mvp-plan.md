# Same MVP plan

## Outcome

A single learner can run Same on Bun with one SQLite database, discuss a goal with an LLM, review a course outline, generate the first module, and study it comfortably on desktop or mobile. The app is a calm course reader, with progress, relevant feedback, and contextual help. An external agent can use a documented API to create the same reviewable content. No deployed service or release is implied by this plan.

## Acceptance criteria

1. A fresh installation starts with documented commands, persists its SQLite database across restarts, and provides an authenticated owner session from multiple devices. Provider credentials stay server-side. The production process runs on Bun; document storage, configuration, backup and restore.
2. The owner configures an OpenAI-compatible endpoint, discusses a topic, sees an outline and can edit it before approving it. Markdown and PDF are optional sources; generated course content identifies supplied sources where possible and identifies ungrounded content. Errors and unavailable providers are visible.
3. After outline approval, generation produces the first module's editable lessons and exercises as a draft. The learner reviews and accepts it. Subsequent modules generate on request; a completed lesson is not silently rewritten. Generation and retry must not discard existing drafts or learner work.
4. A learner can navigate freely, complete a multiple-choice question with immediate deterministic feedback, submit a written response and code for explainable AI feedback, correct an AI judgment, and retry. The MVP does not execute code. Results and completion persist across restart.
5. A separate assessment can draw from multiple lessons, run timed or untimed, and show results and explanations after submission. Progress is based on recorded work, not inferred mastery.
6. A contextual tutor can use the current lesson and relevant attempts, and makes its supplied context visible. A learner can propose and review changes to future material.
7. An authenticated, documented external-agent API creates and revises drafts in the same course model as the built-in flow. The API never completes learning activities for the owner. Export produces readable course files.
8. Desktop and mobile browser checks cover the create → outline → module → exercise → feedback → resume path, including loading, error and empty states. Keyboard access and legible layouts are checked. Use Google Chrome's modern-web-guidance for relevant UI patterns.

## Architecture and decisions

- **Runtime and storage:** Bun and SQLite, single owner, single application instance. Store uploaded source files in a persistent directory; backups must cover both the database and those files. No separate queue, cache, or database service.
- **Framework decision gate:** TanStack Start + React is the leading candidate. Before committing the application architecture, build and run a production spike on Bun that serves a page and API, reads/writes `bun:sqlite`, survives restart, and streams a response. Check SvelteKit's official Bun adapter against the same criteria if the TanStack path is awkward. Record actual command results and choose based on implementation evidence.
- **AI boundary:** An OpenAI-compatible server endpoint and model are configured by the operator. AI outputs are validated before persistence. Keep model calls outside SQLite transactions; show failures and permit retries. Do not assume model grading is authoritative.
- **Interaction:** Course outline, module draft, and accepted learning material are distinct states. Store the learner's work separately from generated content; any revision preserves completed work.
- **Security:** Authentication is required for browser and agent routes; configure a scoped agent credential separately from the owner session. Do not expose provider secrets to the browser. Avoid claiming public-internet readiness before its actual deployment is reviewed.

## Delivery slices

1. **Framework spike and design contract.** Compare the Bun production paths, choose the framework, document setup and define a desktop/mobile lesson, outline and tutor layout. Verify the production server, SQLite persistence and streaming.
2. **Foundation.** Configuration, single-owner authentication, database migrations, course library and durable backup instructions. Gate: production restart preserves an owner session's course data, with access denied when unauthenticated.
3. **Course authoring.** Streaming discussion, outline edit/approval, Markdown/PDF source intake, first-module generation, editable draft and generation errors. Gate: create a small course with a controlled model fixture and reopen its draft after restart.
4. **Learning and feedback.** Lesson reader, deterministic multiple-choice grading, written/code submission with advisory feedback and corrections, retries and progress. Gate: browser completes one of each and reloads results; no code executes.
5. **Assessments and tutor.** Timed/untimed multi-lesson exam, review and contextual tutor, future-module generation and reviewable changes. Gate: complete an exam, resume, and inspect tutor context.
6. **External authoring and portability.** Scoped agent API, documentation and export. Gate: an agent creates a reviewable draft, cannot submit learner work, and exported material is readable outside Same.
7. **Acceptance.** Run the project's checks and a browser journey on desktop and mobile using a real compatible LLM when available. Record model, commands, outcomes, failures, and what was only tested with fixtures. Verify the real production start and persistent volume separately from development.

## Initial framework spike (2026-11-14)

A disposable TanStack Start React scaffold (`@tanstack/react-start` 1.169.5, Nitro 3.0.260610-beta, Bun 1.4.4) built for Nitro's Bun preset. The production server returned HTTP 200 for its page; a `bun:sqlite` endpoint returned visit count 1, then count 2 after a server restart. A separate streaming endpoint delivered its first line immediately and its second approximately 0.5 seconds later. The build emitted warnings that module-level `use client` directives may not be preserved. This is evidence for a minimal server path only: no real LLM, UI, authentication, proxy, migration, backup, load or SvelteKit comparison was tested. The scaffold and database live in ignored scratch and are not application code. TanStack Start remains the provisional choice until the warnings and a representative UI are evaluated.

## Open implementation decisions

- Choose TanStack Start or SvelteKit only after the framework spike; no UI depends on the choice yet.
- Select auth, AI SDK and database tooling based on the smallest solution that meets the criteria; do not assume every TanStack package is required.
- Define an export format after reviewing Apricot's actual Markdown conventions.
- Select the UI visual language from relevant product references; avoid copying branding. Establish a browser support policy and verify mobile and keyboard behavior.

## Non-goals

Classrooms, multiple learners, marketplace, hosted identity, automatic code execution, Kubernetes deployment and a production release are not part of this MVP. Source text and AI feedback can be wrong and must remain inspectable.
