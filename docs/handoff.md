# Same MVP continuation

Updated 2026-11-14. The owner authorized a Bun + SQLite self-hosted learning app, selected `azusachino/same` as class `live`, and requested a written plan with Herdr Pi peers using Haiku and DeepSeek. The acceptance criteria and ordered slices are in [mvp-plan.md](mvp-plan.md).

## Checkpoint

- Workstation catalog onboarding: isolated branch `task/same-onboarding`, commit `55fe224`; the Same checkout is `vendor/same` within that workstation worktree. Root `make validate` failed on existing shared-toolchain mismatches: Cappuccino `rumdl` 0.2 vs 0.3, Cinnamon Python 3.14 vs 3.15 and uv 0.12 vs 0.13. Root `make build-docs` passed. Do not push the catalog PR until its required gate passes; other projects' checkouts are shared and were not edited.
- Same: branch `task/mvp`, base `8720c1cff5c68599f49def573efd0bbd3430ee19`. Latest actual commit and uncommitted changes must be read from `git status`/`git log`, not inferred from this note.
- Implemented: Bun production build and SQLite, owner password session, goal library, conversation and outline approval, first module generation with a review/edit/accept step, multiple-choice and advisory written/code feedback, corrections, source ingestion for Markdown and PDF, a scoped draft-authoring agent API, and Markdown export. Code is never executed. An OpenAI-compatible model is configured by server environment variables. Source citations are not verified.
- Checks before the current change: `make check` passed (9 unit tests plus production build and typecheck) and `make e2e` passed 6 Playwright tests across desktop/mobile Chromium with a deterministic model fixture. A later stable-ID migration also passed the same commands. A PDF extraction unit test used a synthetic real PDF. No real model, production reverse proxy, backup restore, or mobile Safari was tested.
- Framework spike: TanStack Start + Nitro Bun preset built and served a page, preserved SQLite across restart, and streamed a small response. `use client` bundler warnings remain. SvelteKit was compared only from official documentation, not prototyped.

## Remaining work

The MVP is **not complete**. The plan still requires later modules and safe accepted-content revision, timed and untimed assessments spanning lessons, contextual tutor with visible context, fuller durable learning progress, source citation verification, resilient and streamed LLM generation, backup/restore proof, and the full acceptance journey. Study exercises support feedback and owner correction; this does not establish grading correctness. The UI must not claim unsupported features.

DeepSeek's read-only review found additional concerns: context can exceed small model limits; PDF extraction lacks a hard timeout; source citations are not verified; the model protocol lacks capability detection; chat is not streamed; process restart is not covered by the application E2E; and the agent credential is single-instance without expiry or audit history. Agent draft revisions and owner acceptance now use optimistic checks to prevent overwriting unseen edits. The single-user global login throttle can temporarily lock out the owner. A temporary provider fixture is not proof of real-model behavior. Address these against the plan, then review the final diff and run the project's gates.

## Peer evidence

Herdr Pi Haiku (`magpie/opencode-go/claude-haiku-5-5`, medium) reviewed authentication and reported default bind, database WAL permissions, request-size and session risks. The server now defaults to loopback, startup applies a restrictive umask, and JSON requests are bounded; those controls still need final independent review. Herdr Pi DeepSeek (`magpie/opencode-go/deepseek-v4.1-flash`, medium) reviewed model, PDF and course generation handling. The lead added larger generation budgets, safe provider errors, no automatic outline overwrite, generation single-flight and exercise IDs; remaining findings are above. These peers reviewed moving files, not a fixed final revision, and their reports are not final acceptance.
