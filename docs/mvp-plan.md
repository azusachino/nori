# Nori MVP plan

## Product role

Nori is a private learning workspace for one person. It helps the learner turn a goal into an editable course, study and practise, and return to their work over time. The model helps plan, draft, explain and review; the learner decides what to study, approves generated material, and can correct feedback. Nori records evidence of learning activity rather than claiming mastery.

The primary journey is **goal → conversation and sources → editable outline → reviewed modules → lessons and exercises → feedback → resume**, with assessments and a contextual tutor.

Nori complements a personal notes vault: the vault remains useful for durable notes and sources, while Nori owns course structure, learner attempts and the study experience. Readable Markdown export is part of the MVP; synchronization with a particular vault is not assumed.

## Learner stories and acceptance

1. **Start and resume.** I can describe a learning goal and my existing knowledge, see my courses, reopen one, and understand what I can do next. Recorded progress distinguishes attempts and completion from inferred mastery.
2. **Bring sources or start from a topic.** I can optionally add Markdown, text or text-based PDF material and remove a source. I can see which sources were supplied and understand that generated content and citations can be inaccurate; topic-only learning remains possible.
3. **Shape the course.** I can discuss my goal with a configured model, review and edit an outline, and approve the saved version. Provider errors are visible and retryable. AI or agent revisions cannot silently overwrite my edits.
4. **Review and study modules.** I can generate modules on request, inspect and edit lessons, questions and reference answers before acceptance, and navigate freely between available lessons. A completed lesson and recorded work are not silently rewritten; proposed future changes are reviewable.
5. **Practise and correct feedback.** I can answer multiple-choice questions with deterministic feedback and submit written and code responses for explainable advisory feedback. I can retry and correct an AI judgment. Nori does not execute code. My answers, feedback and corrections remain reviewable after reopening and restarting.
6. **Check understanding.** I can take a separate timed or untimed assessment spanning multiple lessons, submit it intentionally and review results and explanations.
7. **Ask for help in context.** I can ask a tutor about the current lesson and relevant attempts, inspect what context was supplied and propose changes to future material for review.
8. **Keep and author my work.** I can export readable course material. A documented local-agent API can create and revise reviewable drafts. Agent endpoints are a workflow boundary: any local process that can reach the application can also use learner routes.
9. **Run and trust the workspace.** I can start it using documented commands, keep course data across restarts, back up and restore it, and use it comfortably on desktop and mobile with a keyboard. Errors, draft state and source limitations are visible. Provider credentials remain server-side.

## Current checkpoint

Nori PR [#1](https://github.com/azusachino/nori/pull/1) merged on 2026-11-16, and CI is green on `main` at `5bbd720`. The merged application includes the library, planning and source uploads, editable outline, ordered reviewable modules, exercises and advisory feedback, assessments, contextual tutor, a local draft API, and Markdown export. Code execution is not provided.

What that does **not** show: every journey was run against a deterministic model fixture and disposable data. The MVP is therefore complete in surface and unproven in use. [Issue #5](https://github.com/azusachino/nori/issues/5) is the gate that closes that gap, and sections 1 and 5 below are its work.

At implementation commit `17605b2`, `make check` passed with 13 unit tests, `make e2e` passed 12 desktop/mobile Chromium tests with a deterministic model fixture, and `make e2e-probe` passed. The supported production start was observed bound to loopback even with a conflicting inherited Nitro host. A peer reviewed the six preceding fixes; see [handoff](handoff.md). The fixture does not establish real-model quality. That earlier checkpoint did not verify a real LLM, deployed backup restore, mobile Safari or assistive-technology use.

After the owner accepted the MVP layout direction, AGY implemented the Tailwind/shadcn interface and Nori icon; Pi/DeepSeek implemented multi-module and assessment/tutor backends. At `fd59411`, an independent reviewer ran `make check` (37 tests, 440 assertions), `make e2e` (36 Chromium desktop/mobile tests) and two targeted browser probes. The review found unsaved practice drafts, assessment state synchronization and timer display issues; an independent recheck at `d36446e` verified the fixes, with 37 backend tests, 44 Chromium desktop/mobile tests and targeted browser probes. A disposable SQLite WAL backup/restore test passes. The real-model journey, mobile Safari and assistive-technology use remain unverified.

## Product and technical boundaries

- **Personal and local:** one learner, one application instance, SQLite and no browser login. The supported production command binds to loopback and rejects unexpected hosts and cross-origin browser writes. Local processes can read and change learner data; remote access needs a separately secured access layer.
- **Storage and portability:** original uploads, extracted text, course material and learner work are stored in SQLite. Provide backup and restore instructions that account for SQLite WAL. Export remains readable outside Nori.
- **Model boundary:** the operator configures an OpenAI-compatible endpoint. Validate generated output before persistence, keep model calls outside database transactions, and make failures and retries visible. Feedback is advisory; citations are not verified by default.
- **Current implementation:** React, TanStack Start, Nitro's Bun preset and `bun:sqlite` are in PR #1. A Bun production spike served a page and API, retained SQLite across restart and streamed a test response. SvelteKit was reviewed from documentation but not prototyped. Node 26 was discussed as a possible alternative, not chosen; a migration would need its own SQLite, runtime, persistence and test assessment.
- **UI direction:** Tailwind and shadcn/ui were requested. The owner said the proposed library, planning and study layouts suit an MVP; detailed visual decisions and a real-course walkthrough remain open. The [UI design](ui-design.md) records that direction.
- **Excluded:** classrooms, multiple users, a marketplace, hosted identity, automatic code execution, Kubernetes deployment and production release.

## Ordered plan

The first task is a product-design checkpoint. Later tasks describe intended work; their presence does not mean the features are implemented or that the owner has selected a particular real learning topic.

### 1. Ground the design in a real learning journey

- [ ] Choose a real topic and learning goal with the owner, including current experience and what a useful outcome looks like. Use optional existing sources if relevant.
- [ ] Walk through starting, planning, reviewing, studying, practising and returning. Identify the questions, decisions, saved state and failure cases at each step.
- [ ] Apply the owner's acceptance of the library, planning and study layout direction to the real-course walkthrough; refine the detailed desktop/mobile designs in [the UI design](ui-design.md).

**Done when:** the owner can follow one concrete journey and the design distinguishes present functionality from later-MVP screens. No real course topic or design approval has been assumed.

### 2. Establish the UI foundation and first course journey

- [x] Verify the Tailwind/shadcn foundation and Nori icon against the agreed design. Use only the components the journey needs and preserve local access and draft-conflict behavior.
- [x] Deliver library, planning, source management, outline approval, module review and study/practice as small, verifiable slices. Cover empty, loading, failure, unsaved and conflict states.
- [x] Check keyboard use, responsive layout, recorded attempts and advisory feedback. Preserve accepted content and existing data.

**Verify:** `make check`, relevant desktop/mobile browser journeys and visual inspection; complete `make e2e` and `make e2e-probe` at the stable checkpoint. Record browser and accessibility limits.

### 3. Make a course safely continue across modules

- [x] Design and migrate the single-module-per-course storage to support ordered modules and lessons without losing existing drafts, attempts or identities.
- [x] Generate later modules on request; let the learner navigate and see progress based on stored activity. Require review of changes to future material and preserve completed work.
- [x] Verify migration, restart, retry and conflict behavior using an existing single-module course and a new multi-module course.

**Done when:** the real learning journey can continue beyond its first accepted module without silently changing earlier work. Acceptance and migration were tracked in [issue #2](https://github.com/azusachino/nori/issues/2) and delivered in PR #1; the real-course proof is [issue #5](https://github.com/azusachino/nori/issues/5).

**Integration contract, delivered in PR #1:** retain the original `module` field and legacy actions targeting the first module. Return an ordered `modules` array; new later-module creation uses a separate plural endpoint, and editing, acceptance, answers and corrections for later modules carry an explicit `moduleId`. Never retarget an old client silently. Preserve existing module and exercise IDs, accepted content, attempts and corrections across migration and restart. Agent reads expose accepted-module metadata and unaccepted draft content; stale draft writes return a conflict.

### 4. Add assessments and contextual help

Tracked separately as [assessments #4](https://github.com/azusachino/nori/issues/4) and [contextual tutor #3](https://github.com/azusachino/nori/issues/3), both delivered in PR #1 on the multi-module contract. Real-model behaviour is [issue #5](https://github.com/azusachino/nori/issues/5).

- [x] Build timed and untimed assessments spanning multiple lessons, with explicit submission, persisted results and explanations.
- [x] Add a tutor scoped to the current lesson and relevant attempts; show what context it receives and route proposed future changes through review.

**Verify:** complete and resume each assessment mode, inspect results and tutor context, and confirm completed content and attempts remain intact.

### 5. Prove portability and end-to-end use

- [ ] Exercise the documented local-agent workflow and readable Markdown export on a representative course.
- [ ] Verify production restart and a backup/restore into a separate location. Run a real-model journey when a compatible provider is available, recording its model, failures and quality limits.
- [ ] Complete desktop/mobile browser and keyboard checks; separately record mobile Safari and assistive-technology coverage or lack of it. Check generated source references against the supplied material; do not claim verification without evidence.

**Done when:** the agreed MVP stories have observable evidence, remaining limits are recorded, and the course can be reopened, exported and restored. This section and section 1 are [issue #5](https://github.com/azusachino/nori/issues/5).

## Open decisions and risks

- **Real course:** the topic, starting knowledge, sources and successful outcome for the design walkthrough still need the owner's choice.
- **UI:** the visual language and screen layouts in the current UI draft need review; Tailwind/shadcn are requested tooling, not a substitute for this decision.
- **Runtime:** keep the current Bun implementation for this plan unless a separate Node migration is selected and verified. Nitro is the current server layer, not a database or separate required service.
- **Grounding and model limits:** source citations may be invented, providers have different context windows, and real-model behavior is not established by fixtures. Decide what source evidence to show and test it with real material.
- **Data safety:** multi-module changes and future revisions must preserve old course content and attempts. Backup restoration and production restart remain acceptance work.
- **Provider and UI reliability:** PDF extraction has no hard timeout; chat is not streamed; a server-side edit conflict preserves work but requires refreshing to update the editor's conflict state.

## Research and historical evidence

The workstation's `docs/runbooks/research/2026-11/2026-11-13-self-hosted-ai-learning.md` compared documented project capabilities, not hands-on installations. LearnHouse informed conversational course creation; Lextures informed agent authoring; Open Tutor informed portable course files. None is a proven replacement without a representative trial.

AME's [learner information architecture audit](https://github.com/mikafans/ame/blob/1585260025e33f2ea387d141efa8a37c119d2d16/docs/audits/2026-08-03-learner-information-architecture-research.md) recommends course-scoped navigation and a clear next action. Its [agent authoring audit](https://github.com/mikafans/ame/blob/1585260025e33f2ea387d141efa8a37c119d2d16/docs/audits/2026-08-02-agent-course-author-simulations.md) describes handoff and list/detail inconsistencies. These are source-review findings, not issues reproduced in Nori.

The Bun spike built TanStack Start + Nitro, served a page, retained a SQLite counter over restart and delivered a streamed response in two chunks. It emitted `use client` bundler warnings. That limited result did not test the full application, a real provider, a proxy, backup restore, or a SvelteKit implementation.
