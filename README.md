# nori

An embeddable practice SDK and headless SQLite/LLM sidecar (`0.0.1` MVP) for personal static learning sites, alongside Nori's original self-hosted learning workspace.

- **Sidecar & SDK (MVP):** run `make sidecar` (`127.0.0.1:3001`, `/api/nori/v1`) and embed `<NoriPractice />` (`nori/react`, `nori/styles.css`) into static course pages for persistent attempts, deterministic multiple-choice checking, advisory AI feedback, owner corrections, and offline local-draft fallback. See [the sidecar API contract](docs/sidecar-api.md) and [CHANGELOG.md](CHANGELOG.md).
- **Standalone workspace:** the earlier slice provides a private library, planning conversations, editable course outlines, ordered modules, [timed or untimed assessments](docs/assessments.md), a [contextual tutor](docs/tutor.md), and a local [agent API](docs/agent-api.md). AI feedback is advisory and code is not executed. See [the MVP plan](docs/mvp-plan.md).

## Run locally

Requires Bun 1.4 or newer. Install dependencies with `bun install --frozen-lockfile`, run `make dev`, and open `http://localhost:3000`.

The database defaults to `.data/nori.sqlite`. If an existing `.data/same.sqlite` is present, Nori continues to use it to preserve your data. To use another location, set `NORI_DATABASE_PATH`. An existing one-module database is upgraded in place on start: course data, module and exercise IDs, accepted status, attempts and corrections are preserved, and restarting does not repeat the migration. Assessment tables are added on start without changing existing modules or attempts. `NORI_ORIGIN` defaults to `http://localhost:3000`; set it to the local origin when using a different port. `bun run start` binds to `127.0.0.1`; do not run the generated server entry point directly, because it may listen on all interfaces. Nori has no login: local processes can read and modify the library and use the configured model. Do not expose the server to a network or untrusted proxy. Remote access requires a separately secured access layer.

To use course planning, set `NORI_LLM_BASE_URL` to an OpenAI-compatible API base (for example, `http://localhost:11434/v1`), `NORI_LLM_MODEL` to your model name, and optionally `NORI_LLM_API_KEY` for a hosted provider. These values stay on the server. Your learning goal, planning conversation, and uploaded source text are sent to the configured provider when generating an outline or module. Uploaded original files and extracted text are stored in the SQLite database. Scanned PDFs require OCR before upload. Provider responses are AI-generated and may be inaccurate.

Existing `SAME_` configuration for the database, origin and model still works after the rename. When both names are set, the corresponding `NORI_` variable takes precedence.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and pull request guidance, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

Nori is licensed under the [Apache License 2.0](LICENSE).

## Checks

- `make check` builds the production application, checks TypeScript and runs backend tests.
- `make e2e-install` installs the Playwright Chromium browser.
- `make e2e` exercises desktop and mobile planning, practice, assessments and tutoring with a local model fixture, persistence and access control using a test database under `.tmp/e2e/`.

Production output is started with `bun run start` after `make build`. [Back up and restore](docs/backup.md) with SQLite's online backup API or `VACUUM INTO` while the server runs, and restore only with the server stopped; copying only the database file while WAL is active can omit data. A scratch automated test covers a live WAL `VACUUM INTO` backup and independent reopen; a deployed proxy or real production restore has not been tested.
