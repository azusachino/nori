# nori

An embeddable practice SDK and headless SQLite/LLM sidecar (`0.0.1` MVP) for personal static learning sites (such as Apricot).

- **Embeddable SDK (`.`, `./react`, `./styles.css`):** typed `NoriClient`, deterministic multiple-choice checker, `localStorage` draft helpers, client-side Markdown exporter, and drop-in React islands (`<NoriPractice />`, `<NoriAssessment />`, `<NoriTutor />`) styled via semantic CSS custom properties.
- **Headless sidecar (`/api/nori/v1`):** Bun HTTP server backed by `bun:sqlite` and Drizzle ORM (`drizzle/*.sql` migrations). Stores external-keyed practice attempts, server-clock timed/untimed assessments, and deduplicated contextual tutor turns, while keeping `NORI_LLM_API_KEY` strictly server-side. AI feedback is always advisory (`advisory: true`) and learner code is never executed.

See [the sidecar API contract](docs/sidecar-api.md), [backup & restore](docs/backup.md), and [CHANGELOG.md](CHANGELOG.md).

## Run locally

Requires Bun 1.4 or newer:

```sh
bun install --frozen-lockfile
make sidecar
```

By default the sidecar listens on `http://127.0.0.1:3001/api/nori` and stores data in `.data/nori.sqlite`.

Environment variables:

- `NORI_HOST` — bind address (default `127.0.0.1`).
- `NORI_PORT` — listen port (default `3001`).
- `NORI_BASE_PATH` — URL mount prefix (default `/api/nori`; set to `""` or `"/"` behind a path-stripping reverse proxy).
- `NORI_DATABASE_PATH` — SQLite file path (default `.data/nori.sqlite`).
- `NORI_LLM_BASE_URL` — OpenAI-compatible API base (e.g. `http://127.0.0.1:11434/v1`).
- `NORI_LLM_MODEL` — model name.
- `NORI_LLM_API_KEY` — optional provider key (kept strictly server-side).

Nori is single-owner, personal-use only, and has no authentication. Keep the sidecar bound to loopback (`127.0.0.1`) or private to your tailnet; never expose it to the public internet.

## Run with Podman / Docker (`Containerfile`)

Build the container image:

```sh
podman build -t nori-sidecar:0.0.1 -f Containerfile .
```

Run bound to host loopback with a persistent `/data` volume:

```sh
podman run -d --name nori-sidecar \
  -p 127.0.0.1:3001:3001 \
  -v nori-data:/data \
  -e NORI_LLM_BASE_URL="http://host.containers.internal:11434/v1" \
  -e NORI_LLM_MODEL="qwen3" \
  nori-sidecar:0.0.1
```

Verify liveness:

```sh
curl -sS http://127.0.0.1:3001/api/nori/v1/health
```

## Database migrations (Drizzle)

Schema lives in [src/lib/server/schema.ts](src/lib/server/schema.ts) and generated SQL migrations live in [drizzle/](drizzle/) (`0000_sidecar_init.sql`). Migrations run automatically on startup. To generate a new migration after editing `schema.ts`:

```sh
bun run db:generate -- --name <migration_name>
```

[Back up and restore](docs/backup.md) with SQLite's online backup (`VACUUM INTO`) while the sidecar runs, and restore only with the sidecar stopped.

## Checks

- `make check` builds the SDK declarations (`dist/sdk`), runs `tsc --noEmit`, and runs the Bun test suite (`bun test src`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and pull request guidance, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

Nori is licensed under the [Apache License 2.0](LICENSE).
