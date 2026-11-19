# Contributing to Nori

Nori is an embeddable practice SDK and headless SQLite/LLM sidecar for personal static learning sites. Issues and pull requests are welcome; for a substantial change, open an issue first so the approach and scope can be discussed.

## Set up

Install Bun 1.4 or newer, then run:

```sh
bun install --frozen-lockfile
make sidecar
```

The sidecar listens on `http://127.0.0.1:3001/api/nori`. To use model-backed advisory feedback or the contextual tutor, configure an OpenAI-compatible provider as described in the [README](README.md).

## Check a change

```sh
make check
```

`make check` builds the SDK (`dist/sdk`), checks TypeScript types (`tsc --noEmit`), and runs the backend and SDK unit tests (`bun test src`).

When changing [src/lib/server/schema.ts](src/lib/server/schema.ts), generate a named SQL migration under `drizzle/`:

```sh
bun run db:generate -- --name <migration_name>
```

Describe the problem, the change, and the checks you ran in your pull request. Do not include personal learning data, model credentials, or SQLite database files in issues, pull requests, or test fixtures.

## Project boundaries

Nori is designed for one learner on a trusted local machine or private tailnet. AI feedback is advisory (`advisory: true`), and learner code is never executed.
