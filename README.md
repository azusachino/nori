# nori

A small self-hosted learning space, in development. The current slice provides a private library, planning conversations, editable course outlines, and ordered modules with multiple-choice, written and code exercises. A later module is generated on request, reviewed and accepted without rewriting accepted modules or learner work. The [assessment](docs/assessments.md) backend API is implemented for accepted lessons, timed or untimed, with recorded results and explanations after submission; the learner assessment interface is not integrated yet. AI feedback is advisory and code is not executed. Markdown, text and text-based PDFs (up to 5 MB and 50 pages) can be supplied as source material. A local [agent API](docs/agent-api.md) can create drafts for review. Courses can be exported as readable Markdown. Tutoring is not implemented yet. See [the MVP plan](docs/mvp-plan.md).

## Run locally

Requires Bun 1.4 or newer. Install dependencies with `bun install --frozen-lockfile`, run `make dev`, and open `http://localhost:3000`.

The database defaults to `.data/nori.sqlite`. If an existing `.data/same.sqlite` is present, Nori continues to use it to preserve your data. To use another location, set `NORI_DATABASE_PATH`. An existing one-module database is upgraded in place on start: course data, module and exercise IDs, accepted status, attempts and corrections are preserved, and restarting does not repeat the migration. Assessment tables are added on start without changing existing modules or attempts. `NORI_ORIGIN` defaults to `http://localhost:3000`; set it to the local origin when using a different port. `bun run start` binds to `127.0.0.1`; do not run the generated server entry point directly, because it may listen on all interfaces. Nori has no login: local processes can read and modify the library and use the configured model. Do not expose the server to a network or untrusted proxy. Remote access requires a separately secured access layer.

To use course planning, set `NORI_LLM_BASE_URL` to an OpenAI-compatible API base (for example, `http://localhost:11434/v1`), `NORI_LLM_MODEL` to your model name, and optionally `NORI_LLM_API_KEY` for a hosted provider. These values stay on the server. Your learning goal, planning conversation, and uploaded source text are sent to the configured provider when generating an outline or module. Uploaded original files and extracted text are stored in the SQLite database. Scanned PDFs require OCR before upload. Provider responses are AI-generated and may be inaccurate.

Existing `SAME_` configuration for the database, origin and model still works after the rename. When both names are set, the corresponding `NORI_` variable takes precedence.

## Checks

- `make check` builds the production application and runs TypeScript checks.
- `make e2e-install` installs the Playwright Chromium browser.
- `make e2e` exercises desktop and mobile planning and practice with a local model fixture, persistence and access control using a disposable database under `.tmp/e2e/`.

Production output is started with `bun run start` after `make build`. Back up the SQLite database with SQLite's online backup API or `VACUUM INTO` while the server runs; copying only the database file while WAL is active can omit data. This initial slice has not yet been tested for a deployed remote proxy or backup restoration.
