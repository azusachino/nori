# Nori UI direction and delivery plan

The owner said the proposed library, planning and study layouts suit an MVP. The detailed visual direction and the real-course walkthrough remain open. The ordered product plan in [mvp-plan.md](mvp-plan.md) takes precedence over the candidate implementation steps below.

## Purpose and scope

Nori is a private learning space for one person. Its interface should make it easy to return to a topic, review AI-generated material before studying, and understand what has actually been attempted. It should feel like a quiet working notebook: useful while planning, unobtrusive while reading, and candid about unverified content.

This design covers the whole MVP in [mvp-plan.md](mvp-plan.md). The first implementation below only changes the existing library, planning, draft and practice flows. Later modules, assessment and contextual tutoring are design targets, not features shipped by the initial UI migration.

## User stories

1. **Start and resume.** As a learner, I can save a goal, see my existing courses and reopen one without hunting through a dashboard. An empty library explains the next action; a loading or failed request says what happened.
2. **Shape a course.** I can discuss my experience, optionally add or remove sources, generate an outline, edit it and explicitly approve the saved version. I can distinguish the conversation, sources and outline, and a conflicting change never silently replaces my edits.
3. **Review before studying.** I can inspect a generated module's lessons, questions, answers and explanations, edit and save them, then accept the saved draft. Unsaved, saving, conflicting and failed states must be clear.
4. **Study and practice.** I can read lessons at a comfortable measure, answer multiple-choice, written and code exercises, and see feedback next to my work. AI feedback is labelled advisory; code is not run. I can see my previous answers and corrections when I return.
5. **Navigate further** (later MVP). I can move between modules and lessons and see recorded progress without the interface implying mastery or silently revising completed material.
6. **Check understanding** (later MVP). I can choose a timed or untimed assessment, see its scope and remaining time where applicable, submit intentionally, and review results and explanations.
7. **Ask for help** (later MVP). I can open a contextual tutor beside the material, see what context it received and propose changes for review without losing my place.

## Information architecture

- **Library:** course list and a clearly labelled new-goal form. Opening a course leads back to the library. Course status must only reflect data the application actually records.
- **Planning:** one course header, conversation and source controls, with the outline adjacent on wide screens and following the conversation on narrow screens. Approve only a saved outline.
- **Draft review:** editable module content and reference answers, followed by save and accept actions. Keep conflict and validation feedback next to the work.
- **Study:** accepted lesson text first, then exercises and their recorded attempts. Retain access to planning without placing it ahead of every lesson on return.
- **Future:** course navigation, an assessment flow and a contextual tutor should have dedicated views or panels when their underlying capabilities exist. Do not add inactive navigation for them now.

## Visual and interaction contract

- Use the existing warm paper background, dark ink, restrained green actions and small rust accent as the starting visual identity. Keep display headings distinct from readable system-sans body text; avoid decorative dashboard cards and heavy shadows.
- Let lesson and answer content lead. Use a comfortable reading measure, meaningful headings, generous line height, and clear separation between learner input, saved attempts and advisory feedback.
- Desktop can use a two-column library and planning layout. At narrow widths use one column in DOM order, readable controls and no horizontal page overflow. Long user and model text must wrap.
- Use labelled native form controls, visible keyboard focus, descriptive errors and touch targets. Preserve focus and unsaved text when a request fails or another author changes a draft.
- Show loading, empty, error, draft, saved, approved and accepted states in words, not colour alone. Only show progress supported by stored attempts.
- Prefer native disclosure and radio controls where suitable. Use shadcn/ui components as owned, customizable source where they add consistency or accessibility; do not install a catalogue of unused components.
- Style with Tailwind tokens and utilities, keeping any remaining project CSS deliberate and readable. Build controls around semantic roles rather than styling all HTML elements globally.

## Implementation tasks

1. **Foundation:** after reviewing a concrete learning journey and agreeing on its UI, evaluate the paused Tailwind/shadcn changes and set up the chosen components for the existing React/TanStack Start app. Add only the button and form components used in this slice. Acceptance: production build and typecheck work; current flows remain functional. Verify: `make check` and focused browser checks.
2. **Library controls:** apply shared controls and tokens to goal creation, including loading, empty and error states; remove stale copy about generation being unavailable. Acceptance: keyboard and touch users can create and open a course. Verify: library browser journey on desktop and mobile.
3. **Planning and review controls:** migrate conversation, source, outline and module draft controls in small steps, preserving optimistic conflict handling. Acceptance: editing, approval, source removal and conflict recovery still work. Verify: agent and library browser journeys on both viewports.
4. **Study and feedback:** apply the same controls to exercises and correction forms while keeping saved answers and advisory labels visible. Acceptance: all three exercise types, retries and historical corrections remain usable. Verify: browser journey plus screenshot inspection at desktop and mobile widths.
5. **Acceptance:** run `make check`, `make e2e` and `make e2e-probe`; inspect rendered desktop/mobile screens and keyboard focus. Update the PR with implementation evidence and remaining limitations.

These steps follow the owner's acceptance of the broad layout direction. The Tailwind/shadcn foundation and Nori icon are implemented locally; integration and full verification continue. A real-course walkthrough and detailed visual review remain open. Do not redesign the runtime, add auth, or implement the later-MVP stories as part of this UI foundation. A real model, mobile Safari, assistive-technology testing and backup restore require separate verification.

## Sources and validation

The existing interface and the course journey in `docs/mvp-plan.md` are the product reference. The proposed UI foundation refers to the [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite) and [shadcn/ui Vite setup](https://ui.shadcn.com/docs/installation/vite). Google Chrome's modern web guidance informs semantic form controls, responsive layouts and keyboard access. The current Playwright fixture covers desktop and mobile Chromium; it does not establish mobile Safari or screen-reader behavior.
