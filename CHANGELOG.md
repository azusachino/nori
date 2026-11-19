# Changelog

## Unreleased

## 0.0.1

Initial MVP release of Nori as an embeddable practice SDK and headless local/tailnet sidecar for static learning sites.

- **Headless sidecar v1 practice API.** `make sidecar` (`bun run src/sidecar-server.ts`) serves `/api/nori/v1/health` and external-keyed `/api/nori/v1/practice/*` routes backed by `bun:sqlite` (`practice_attempts` table). Supports deterministic multiple-choice grading, immediate written/code attempt persistence decoupled from LLM availability, advisory AI feedback (`advisory: true`, untrusted-data prompt framing, calls outside SQLite transactions), owner corrections with optimistic concurrency (`version` / `409`), and configurable `NORI_BASE_PATH` for reverse proxies. See [docs/sidecar-api.md](docs/sidecar-api.md). ([#7](https://github.com/azusachino/nori/pull/7))
- **Embeddable single-package SDK.** Exports `.` (`NoriClient`, `computeContentHash`, `checkMultipleChoice`, `localStorage` draft helpers, client-side `formatAttemptsAsMarkdown`), `./react` (`<NoriPractice />` island with offline local-draft mode, manual submit-to-Nori reconciliation, and content-drift detection), and `./styles.css` (scoped `.nori-*` styles mapped to semantic theme tokens). Declares `react` and `react-dom` as `peerDependencies`. ([#7](https://github.com/azusachino/nori/pull/7))
- **Core SQLite & learning foundations.** Preserves the WAL online backup workflow (`VACUUM INTO`), non-executing code handling, and existing multi-module, timed/untimed assessment, and contextual tutor backends on `main`.
