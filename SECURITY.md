# Security

Nori runs as a personal, single-owner sidecar backed by SQLite and an OpenAI-compatible LLM provider, paired with an embeddable browser SDK. Keeping provider credentials server-side and never executing learner code are the primary security boundaries.

## Reporting a vulnerability

Please **do not open a public issue**. Use [GitHub's private vulnerability reporting](https://github.com/azusachino/nori/security/advisories/new), or the contact on the maintainer's GitHub profile. Include what the issue allows and a concrete reproduction.

## In scope

- Any way for `NORI_LLM_API_KEY` or other server-side provider credentials to leak into SDK bundles, HTTP responses, or error messages.
- Any path that executes learner-submitted code or evaluates untrusted exercise/lesson payloads as code.
- Request-handling flaws that bypass JSON body limits, corrupt SQLite state across concurrent writes, or allow SQL injection / path traversal via external keys.

## Known, accepted tradeoffs

- **No authentication on the sidecar.** The v1 sidecar is designed for single-owner personal use on loopback (`127.0.0.1`) or a private tailnet, never exposed to the public internet.
- **Advisory AI output.** Model feedback is generated from untrusted study material framed as data; it is advisory only and not a verified grade or citation check.
