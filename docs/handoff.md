# Nori MVP continuation

Updated 2026-11-17. The owner authorized a Bun + SQLite self-hosted learning app, selected the project (`azusachino/nori`) as class `live`, and asked for a written plan with Herdr Pi peers. The acceptance criteria and ordered slices are in [mvp-plan.md](mvp-plan.md).

## Active continuation

The MVP surface is merged and unproven in use. PR [#1](https://github.com/azusachino/nori/pull/1) merged on 2026-11-16; `main` is at `5bbd720` with green CI, and `make check` on that tree passes 37 tests and 440 assertions. Everything was exercised against a deterministic model fixture and disposable data, so no claim about a real course, a real model or a deployed restore has evidence yet.

The next milestone is [issue #5, "Prove the MVP on one real course"](https://github.com/azusachino/nori/issues/5), which is sections 1 and 5 of the plan. It cannot start until the owner picks one real topic, the learner's existing knowledge, optional sources and a useful outcome. Then: run the whole journey with a real model and record the provider, model, failures and quality; prove production restart plus a backup and restore into a separate location; exercise export and the local agent API on that same course; run the desktop/mobile Chromium and keyboard pass while recording mobile Safari and assistive technology as covered or not; and check generated citations against the supplied material.

Inspect current Git and agent state before resuming; this is a checkpoint, not a lock.

## What is where

- Repository: `azusachino/nori`, default branch `main`.
- Workstation: catalog entry merged as harus-workstation PR [#133](https://github.com/azusachino/harus-workstation/pull/133); the checkout is `vendor/nori` in the main workstation checkout.
- Purged on 2026-11-17: the parked workstation worktree `.worktrees/same-onboarding` and its nori branch `task/nori-multimodule`. Its commits were verified patch-equivalent to `main` before removal, so no path or branch from that earlier note survives. Do not look for it, and do not treat its name as a live handoff.

## Delivered

Bun production build and SQLite, loopback-only personal access without a password, goal library, planning conversation and outline approval, ordered reviewable modules with generation on request, multiple-choice and advisory written/code feedback, corrections, source ingestion for Markdown and text-based PDF, timed and untimed assessments, a contextual tutor with inspectable context, a local draft-authoring agent API, and Markdown export. Code is never executed. An OpenAI-compatible model is configured by server environment variables.

## Unproven

- Real-model behaviour of any kind: planning quality, generated module quality, feedback accuracy, assessment calibration, tutor answers.
- Generated source citations against the supplied material; citations are not verified by default.
- Production restart, a deployed reverse proxy, and a backup/restore into a separate location. The WAL `VACUUM INTO` test uses disposable data.
- Mobile Safari and assistive-technology use.
- Grading correctness: exercises support feedback and owner correction, which is not the same thing.

Known risks to test or record: context exceeding a smaller model's limit, PDF extraction without a hard timeout, no model capability detection, non-streaming chat, no process-restart application end-to-end test, and learner routes reachable by any local process.

## Peer evidence

Herdr Pi Haiku (`magpie/opencode-go/claude-haiku-5-5`, medium) and DeepSeek (`magpie/opencode-go/deepseek-v4.1-flash`, medium) reviewed PR #1 at `c4ecfd8`. After the review fixes, a fresh DeepSeek peer independently reviewed `17605b2`: it judged all six fix criteria met, reproduced the context-budget and request-size checks, and inspected the lead's gate evidence. It did not run the browser journey or independently measure the production listener, and it noted that a server-side 409 preserves edits but needs a refresh to update the editor's conflict state. A later independent recheck at `d36446e` verified the unsaved-draft, assessment-state and timer fixes with 37 backend tests, 44 Chromium desktop/mobile tests and targeted browser probes.
