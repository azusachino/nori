# Changelog

## 0.0.1

Initial MVP release of Nori as a pure embeddable practice SDK and headless SQLite/LLM sidecar for personal static learning sites.

- **Headless sidecar v1 API (`/api/nori/v1`).** `make sidecar` (`bun run src/sidecar-server.ts`) serves `/v1/health`, `/v1/practice/*`, `/v1/assessments/*` (server-clock timed/untimed assessments with expiry across restarts), and `/v1/tutor` (scoped attempt context, 256 KB body limit, 120,000-char context budget, untrusted-data framing, and deduplicated lesson text storage). See [docs/sidecar-api.md](docs/sidecar-api.md). ([#7](https://github.com/azusachino/nori/pull/7), [#8](https://github.com/azusachino/nori/pull/8))
- **Drizzle ORM & SQL migrations.** Schema lives in `src/lib/server/schema.ts` with generated SQL migrations in `drizzle/0000_sidecar_init.sql`, applied automatically on startup over `bun:sqlite` in WAL mode (`VACUUM INTO` online backup). ([#8](https://github.com/azusachino/nori/pull/8))
- **Single-package SDK (`.`, `./react`, `./styles.css`).** Exports `NoriClient`, `computeContentHash`, `checkMultipleChoice`, `localStorage` draft helpers, client-side `formatAttemptsAsMarkdown`, and `<NoriPractice />`, `<NoriAssessment />`, and `<NoriTutor />` React islands with scoped theme-token CSS. Declares `react` and `react-dom` as `peerDependencies` and `drizzle-orm` as the sole runtime dependency. ([#7](https://github.com/azusachino/nori/pull/7), [#8](https://github.com/azusachino/nori/pull/8))
- **Container image.** Added `Containerfile` (on the shared `azusachino.com/media-base:py3.14-trixie-r2` base for `harus-k3s`, leaving probes and PVC mounts to Kubernetes) and `.dockerignore`. ([#8](https://github.com/azusachino/nori/pull/8))
