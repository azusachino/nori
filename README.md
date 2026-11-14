# nori

A small self-hosted learning space, in development. The current slice provides a private library, planning conversations, editable course outlines, and a generated first module with multiple-choice, written and code exercises. AI feedback is advisory and code is not executed. Markdown, text and text-based PDFs (up to 5 MB and 50 pages) can be supplied as source material. A scoped [agent API](docs/agent-api.md) can create drafts for owner review. Courses can be exported as readable Markdown. Exams and later modules are not implemented yet. See [the MVP plan](docs/mvp-plan.md).

## Run locally

Requires Bun 1.4 or newer. Install dependencies with `bun install --frozen-lockfile`. Choose a password and generate its Argon2id hash locally:

```sh
bun -e 'console.log(await Bun.password.hash(prompt("Password: ")!))'
```

Set `NORI_PASSWORD_HASH` in your environment to the resulting hash. Do not commit the hash or your password. Then run `make dev` and open `http://localhost:3000`. Without a configured hash, sign-in fails closed. The web app uses a single owner password; there is no account registration.

The database defaults to `.data/nori.sqlite`. If an existing `.data/same.sqlite` is present, Nori continues to use it to preserve your data. To use another location, set `NORI_DATABASE_PATH`. Set `NORI_ORIGIN` to the exact public origin, including scheme and port, when accessing from another device; use HTTPS for remote access. `NORI_ORIGIN` defaults to `http://localhost:3000`. The production server binds to `127.0.0.1` by default; set `NORI_BIND` explicitly if the reverse proxy must connect over another interface. Terminate HTTPS at a trusted reverse proxy that forwards the original Host header. Do not expose the development server publicly.

To use course planning, set `NORI_LLM_BASE_URL` to an OpenAI-compatible API base (for example, `http://localhost:11434/v1`), `NORI_LLM_MODEL` to your model name, and optionally `NORI_LLM_API_KEY` for a hosted provider. These values stay on the server. Your learning goal, planning conversation, and uploaded source text are sent to the configured provider when generating an outline or module. Uploaded original files and extracted text are stored in the SQLite database. Scanned PDFs require OCR before upload. Provider responses are AI-generated and may be inaccurate.

Existing `SAME_` environment variables still work after the rename. When both names are set, the corresponding `NORI_` variable takes precedence. Existing browser sessions remain valid.

## Checks

- `make check` builds the production application and runs TypeScript checks.
- `make e2e-install` installs the Playwright Chromium browser.
- `make e2e` exercises desktop and mobile sign-in, planning and practice with a local model fixture, persistence and access control using a disposable database under `.tmp/e2e/`.

Production output is started with `bun run start` after `make build`. Back up the SQLite database with SQLite's online backup API or `VACUUM INTO` while the server runs; copying only the database file while WAL is active can omit data. This initial slice has not yet been tested for a deployed remote proxy or backup restoration.
