# Changelog

## Unreleased

- **Assessments auto-save and count down.** `<NoriAssessment />` saves each answer automatically (debounced, flushed on blur and before submit) with a per-item saved/saving indicator, so submit grades every answer. Timed assessments tick each second as `mm:ss` from the server deadline and lock at expiry, when the sidecar finalizes them as `expired`.
- **Client timeouts, shared connection and offline recovery.** `NoriClient` times out each request (10 s; 100 s for LLM-backed feedback and tutor calls), dedupes identical in-flight GETs, tracks connection state, and retries with backoff while offline. Islands share one client per page via `getSharedNoriClient`, treat a successful data call as the health check, and `<NoriPractice />` re-sends unsent local drafts (`resendLocalDrafts`) when the sidecar answers again.
- **Idempotent attempts.** `POST /v1/practice/attempts` accepts an optional client-generated `id`; repeating it returns the stored attempt instead of inserting another. `<NoriPractice />` reserves the id before sending and keeps it on any unsent draft, so a lost response, a retry or a second tab records each attempt once.
- **Sidecar idle timeout.** `Bun.serve` now sets `idleTimeout: 120` so LLM-backed calls (up to 90 s) are not cut off by Bun's 10 s default.
- **Honest code-check labels and accessibility.** Code checks that do not run the code (Python and other non-JS references) are labelled "Heuristic check, not executed" (`CodeVerificationResult.executed`). Exercise option groups and inputs are labelled by the rendered prompt instead of raw Markdown, and text inputs and keyed options show a visible focus outline.

## 0.1.0

- **Spaced recall, weak-spot queue & expanded exercise primitives (`/v1/review`, `<NoriReviewQueue />`).** Added `GET /api/nori/v1/review` (FSRS/SM-2-style streak & interval scheduling over `practice_attempts`), `<NoriReviewQueue />` React island with inline recall retries, and deterministic grading for `multiple_select` and `cloze` exercises alongside `multiple_choice`.
- **In-browser code verification (`verifyCodeInBrowser`).** Added client-side syntax/delimiter checking, reference-call & forbidden-token assertion checks, and sandboxed Web Worker execution for `[code]` exercises in `<NoriPractice />`.
- **Vault write-back recall digest (`/v1/digest`, `bun run digest`).** Added `GET /api/nori/v1/digest` and `src/cli/digest.ts` CLI to export Obsidian/Apricot-ready Markdown recall digests from the sidecar API or directly from SQLite.
- **Modular SDK components & Miku workbench theme.** Modularized `src/sdk/components/` (`NoriPractice`, `NoriAssessment`, `NoriTutor`, `NoriReviewQueue`, `markdown`, `icons`) and added `resolveNoriIslandProps` for Archify-style vault path inference.

## 0.0.1

Initial MVP release of Nori as a pure embeddable practice SDK and headless SQLite/LLM sidecar for personal static learning sites.

- **Headless sidecar v1 API (`/api/nori/v1`).** `make sidecar` (`bun run src/sidecar-server.ts`) serves `/v1/health`, `/v1/practice/*`, `/v1/assessments/*` (server-clock timed/untimed assessments with expiry across restarts), and `/v1/tutor` (scoped attempt context, 256 KB body limit, 120,000-char context budget, untrusted-data framing, and deduplicated lesson text storage). See [docs/sidecar-api.md](docs/sidecar-api.md). ([#7](https://github.com/azusachino/nori/pull/7), [#8](https://github.com/azusachino/nori/pull/8))
- **Drizzle ORM & SQL migrations.** Schema lives in `src/lib/server/schema.ts` with generated SQL migrations in `drizzle/0000_sidecar_init.sql`, applied automatically on startup over `bun:sqlite` in WAL mode (`VACUUM INTO` online backup). ([#8](https://github.com/azusachino/nori/pull/8))
- **Single-package SDK (`.`, `./react`, `./styles.css`).** Exports `NoriClient`, `computeContentHash`, `checkMultipleChoice`, `localStorage` draft helpers, client-side `formatAttemptsAsMarkdown`, and `<NoriPractice />`, `<NoriAssessment />`, and `<NoriTutor />` React islands with scoped theme-token CSS. Declares `react` and `react-dom` as `peerDependencies` and `drizzle-orm` as the sole runtime dependency. ([#7](https://github.com/azusachino/nori/pull/7), [#8](https://github.com/azusachino/nori/pull/8))
- **Container image.** Added multi-stage `Containerfile` (`oven/bun:1-alpine` build + minimal runtime stage with `tini` as PID 1 and non-root `bun` user, leaving probes and PVC mounts to Kubernetes) and `.dockerignore`. ([#8](https://github.com/azusachino/nori/pull/8))
