# Nori MVP continuation

Updated 2026-11-14. The owner authorized a Bun + SQLite self-hosted learning app, selected the project (now `azusachino/nori`) as class `live`, and requested a written plan with Herdr Pi peers using Haiku and DeepSeek. The acceptance criteria and ordered slices are in [mvp-plan.md](mvp-plan.md).

## Checkpoint

- Workstation catalog onboarding: isolated branch `task/same-onboarding`, commit `55fe224`; the Nori checkout is `vendor/nori` within that workstation worktree. Root `make validate` failed on existing shared-toolchain mismatches: Cappuccino `rumdl` 0.2 vs 0.3, Cinnamon Python 3.14 vs 3.15 and uv 0.12 vs 0.13. Root `make build-docs` passed. Do not push the catalog PR until its required gate passes; other projects' checkouts are shared and were not edited.
- Nori: branch `task/mvp`, base `8720c1cff5c68599f49def573efd0bbd3430ee19`. Latest actual commit and uncommitted changes must be read from `git status`/`git log`, not inferred from this note.
- Implemented: Bun production build and SQLite, loopback-only personal access without a password, goal library, conversation and outline approval, first module generation with a review/edit/accept step, multiple-choice and advisory written/code feedback, corrections, source ingestion for Markdown and PDF, a local draft-authoring agent API, and Markdown export. Code is never executed. An OpenAI-compatible model is configured by server environment variables. Source citations are not verified.
- At `17605b2`, `make check` passed (13 unit tests plus production build and typecheck), `make e2e` passed 12 desktop/mobile Chromium tests using a deterministic model fixture, and `make e2e-probe` passed. With inherited `NITRO_HOST=0.0.0.0`, the supported production start was observed listening on `127.0.0.1:3399`. No real model, production reverse proxy, backup restore, or mobile Safari was tested.
- Framework spike: TanStack Start + Nitro Bun preset built and served a page, preserved SQLite across restart, and streamed a small response. `use client` bundler warnings remain. SvelteKit was compared only from official documentation, not prototyped.

## Remaining work

The MVP is **not complete**. The plan still requires later modules and safe accepted-content revision, timed and untimed assessments spanning lessons, contextual tutor with visible context, fuller durable learning progress, source citation verification, resilient and streamed LLM generation, backup/restore proof, and the full acceptance journey. Study exercises support feedback and owner correction; this does not establish grading correctness. The UI must not claim unsupported features.

Remaining concerns include context exceeding a provider's smaller model limit, PDF extraction without a hard timeout, unverified source citations, no model capability detection, non-streaming chat, and no process-restart application E2E. Local processes can access learner routes and must be trusted. A temporary provider fixture is not proof of real-model behavior.

## Peer evidence

Herdr Pi Haiku (`magpie/opencode-go/claude-haiku-5-5`, medium) and DeepSeek (`magpie/opencode-go/deepseek-v4.1-flash`, medium) reviewed PR #1 at `c4ecfd8`. After the review fixes, a fresh DeepSeek peer independently reviewed `17605b2`: it judged all six fix criteria met, reproduced context-budget and request-size checks, and inspected the lead's gate evidence. It did not run the browser journey or independently measure the production listener. It noted that a server-side 409 preserves edits but requires a refresh to update the editor's conflict state.
