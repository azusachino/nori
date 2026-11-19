# Changelog

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
