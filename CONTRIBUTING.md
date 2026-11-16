# Contributing to Nori

Nori is in development. Issues and pull requests are welcome; for a substantial change, open an issue first so the approach and scope can be discussed.

## Set up

Install Bun 1.4 or newer, then run:

```sh
bun install --frozen-lockfile
make dev
```

Open `http://localhost:3000`. To use model-backed features, configure an OpenAI-compatible provider as described in the [README](README.md). The automated browser tests use a local model fixture and do not need provider credentials.

## Check a change

```sh
make check
make e2e-install
make e2e
```

`make check` builds the app, checks types and runs backend tests. `make e2e` runs the desktop and mobile Chromium journeys against a test database under `.tmp/e2e/`. On Linux, Playwright may require system packages; `bunx playwright install --with-deps chromium` installs them.

Describe the problem, the change and the checks you ran in your pull request. Include screenshots for visible interface changes. Do not include personal course data, model credentials or database files in issues, pull requests or test fixtures.

## Project boundaries

Nori is designed for one learner on a trusted local machine. Generated material needs review, feedback is advisory, and code answers are never executed. Preserve accepted content and learner work when changing course, assessment or tutor behavior. See the [MVP plan](docs/mvp-plan.md) for current scope and known limits.
