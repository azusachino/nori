import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { complete, ModelError } from './ai'
import { INVALID_VIEW_ERROR, parseListView, readJson } from './input'
import {
  sidecarAssessmentAnswers,
  sidecarAssessmentItems,
  sidecarAssessmentResults,
  sidecarAssessments,
  sidecarSchema,
} from './schema'
import {
  gradeDeterministicExercise,
  hashExerciseSnapshot,
  isDeterministicExerciseType,
  parseExerciseSnapshot,
  practiceAdvisoryPrompt,
  validateCourseKey,
  validateExerciseKey,
  validateLessonKey,
  type ExerciseSnapshot,
} from './sidecar'
import { handleTutor, type StreamFn } from './tutor'
import { buildRecallDigest, buildReviewQueue, buildReviewQueueSummary } from './review'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LARGE_BODY_LIMIT = 262144

type SidecarOrm = BunSQLiteDatabase<typeof sidecarSchema>
type AssessmentRow = typeof sidecarAssessments.$inferSelect

function parseExpectedVersion(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

function finalizeAssessmentRow(tx: SidecarOrm, row: AssessmentRow, status: 'submitted' | 'expired', now: number): AssessmentRow {
  const items = tx
    .select()
    .from(sidecarAssessmentItems)
    .where(eq(sidecarAssessmentItems.assessmentId, row.id))
    .orderBy(asc(sidecarAssessmentItems.position))
    .all()
  const answers = new Map(
    tx
      .select()
      .from(sidecarAssessmentAnswers)
      .where(eq(sidecarAssessmentAnswers.assessmentId, row.id))
      .all()
      .map((a) => [a.itemId, a.answer]),
  )
  for (const item of items) {
    const snap = JSON.parse(item.exerciseSnapshot) as ExerciseSnapshot
    const saved = answers.get(item.id) ?? null
    const grading = isDeterministicExerciseType(snap.type) ? 'deterministic' : 'unscored'
    const correct =
      grading === 'deterministic' ? (saved !== null ? gradeDeterministicExercise(snap, saved).correct : 0) : null
    tx.insert(sidecarAssessmentResults)
      .values({
        id: crypto.randomUUID(),
        assessmentId: row.id,
        itemId: item.id,
        answer: saved,
        correct,
        grading,
        feedback: '',
        advisory: 0,
        ownerNote: '',
        createdAt: now,
      })
      .onConflictDoNothing()
      .run()
  }
  const submittedAt = status === 'submitted' ? now : null
  tx.update(sidecarAssessments)
    .set({ status, submittedAt, finalizedAt: now, version: sql`${sidecarAssessments.version} + 1` })
    .where(and(eq(sidecarAssessments.id, row.id), eq(sidecarAssessments.status, 'active')))
    .run()
  return tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, row.id)).get()!
}

function loadAssessment(orm: SidecarOrm, id: string, now: number): AssessmentRow | null {
  return orm.transaction((tx) => {
    const row = tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, id)).get()
    if (!row) return null
    if (row.status === 'active' && row.mode === 'timed' && row.deadlineAt !== null && now >= row.deadlineAt) {
      return finalizeAssessmentRow(tx, row, 'expired', now)
    }
    return row
  })
}

function buildAssessmentDetail(orm: SidecarOrm, row: AssessmentRow, now: number) {
  const finalized = row.status === 'submitted' || row.status === 'expired'
  const items = orm
    .select()
    .from(sidecarAssessmentItems)
    .where(eq(sidecarAssessmentItems.assessmentId, row.id))
    .orderBy(asc(sidecarAssessmentItems.position))
    .all()
  const answers = new Map(
    orm
      .select()
      .from(sidecarAssessmentAnswers)
      .where(eq(sidecarAssessmentAnswers.assessmentId, row.id))
      .all()
      .map((a) => [a.itemId, a.answer]),
  )
  const results = new Map(
    orm
      .select()
      .from(sidecarAssessmentResults)
      .where(eq(sidecarAssessmentResults.assessmentId, row.id))
      .all()
      .map((r) => [r.itemId, r]),
  )

  let answeredCount = 0
  let deterministicTotal = 0
  let deterministicCorrect = 0
  let deterministicIncorrect = 0
  let unscoredCount = 0

  const mappedItems = items.map((item) => {
    const snap = JSON.parse(item.exerciseSnapshot) as ExerciseSnapshot
    const savedAnswer = answers.get(item.id) ?? null
    if (savedAnswer !== null && savedAnswer !== '') answeredCount++
    const res = results.get(item.id)
    if (res) {
      if (res.grading === 'deterministic') {
        deterministicTotal++
        if (res.correct === 1) deterministicCorrect++
        else deterministicIncorrect++
      } else {
        unscoredCount++
      }
    }
    return {
      id: item.id,
      position: item.position,
      lessonKey: item.lessonKey,
      exerciseKey: item.exerciseKey,
      contentHash: item.contentHash,
      type: snap.type,
      prompt: snap.prompt,
      options: snap.options,
      answer: savedAnswer,
      referenceAnswer: finalized ? snap.answer : undefined,
      explanation: finalized ? snap.explanation : undefined,
      result: res
        ? {
            grading: res.grading,
            correct: res.correct,
            feedback: res.feedback,
            advisory: Boolean(res.advisory),
            ownerNote: res.ownerNote,
          }
        : null,
    }
  })

  const remainingMs =
    row.status === 'active' && row.mode === 'timed' && row.deadlineAt !== null ? Math.max(0, row.deadlineAt - now) : null

  return {
    id: row.id,
    courseKey: row.courseKey,
    title: row.title,
    mode: row.mode,
    durationSeconds: row.durationSeconds,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    deadlineAt: row.deadlineAt,
    submittedAt: row.submittedAt,
    finalizedAt: row.finalizedAt,
    version: row.version,
    serverNow: now,
    remainingMs,
    summary: {
      totalItems: items.length,
      answeredCount,
      deterministicTotal,
      deterministicCorrect,
      deterministicIncorrect,
      unscoredCount,
    },
    items: mappedItems,
  }
}

/**
 * Assessment list without items: the header fields and summary counts, counted
 * in SQLite. Expired timed assessments are finalized first, as in the full view.
 */
function listAssessmentSummaries(orm: SidecarOrm, courseKey: string, now: number) {
  const overdue = orm
    .select({ id: sidecarAssessments.id })
    .from(sidecarAssessments)
    .where(
      and(
        eq(sidecarAssessments.courseKey, courseKey),
        eq(sidecarAssessments.status, 'active'),
        eq(sidecarAssessments.mode, 'timed'),
        sql`${sidecarAssessments.deadlineAt} <= ${now}`,
      ),
    )
    .all()
  for (const { id } of overdue) loadAssessment(orm, id, now)

  const rows = orm.all<Record<string, unknown>>(sql`
    SELECT a.*,
      (SELECT COUNT(*) FROM sidecar_assessment_items i WHERE i.assessment_id = a.id) AS total_items,
      (SELECT COUNT(*) FROM sidecar_assessment_answers s WHERE s.assessment_id = a.id AND s.answer <> '') AS answered_count,
      (SELECT COUNT(*) FROM sidecar_assessment_results r WHERE r.assessment_id = a.id AND r.grading = 'deterministic') AS deterministic_total,
      (SELECT COUNT(*) FROM sidecar_assessment_results r WHERE r.assessment_id = a.id AND r.grading = 'deterministic' AND r.correct = 1) AS deterministic_correct,
      (SELECT COUNT(*) FROM sidecar_assessment_results r WHERE r.assessment_id = a.id AND r.grading = 'unscored') AS unscored_count
    FROM sidecar_assessments a
    WHERE a.course_key = ${courseKey}
    ORDER BY a.created_at DESC
  `)
  return rows.map((r) => {
    const status = r.status as AssessmentRow['status']
    const mode = r.mode as AssessmentRow['mode']
    const deadlineAt = r.deadline_at as number | null
    const deterministicTotal = r.deterministic_total as number
    const deterministicCorrect = r.deterministic_correct as number
    return {
      id: r.id as string,
      courseKey: r.course_key as string,
      title: r.title as string,
      mode,
      durationSeconds: r.duration_seconds as number | null,
      status,
      createdAt: r.created_at as number,
      startedAt: r.started_at as number | null,
      deadlineAt,
      submittedAt: r.submitted_at as number | null,
      finalizedAt: r.finalized_at as number | null,
      version: r.version as number,
      serverNow: now,
      remainingMs: status === 'active' && mode === 'timed' && deadlineAt !== null ? Math.max(0, deadlineAt - now) : null,
      summary: {
        totalItems: r.total_items as number,
        answeredCount: r.answered_count as number,
        deterministicTotal,
        deterministicCorrect,
        deterministicIncorrect: deterministicTotal - deterministicCorrect,
        unscoredCount: r.unscored_count as number,
      },
    }
  })
}

export async function handleSidecarActivities(
  orm: SidecarOrm,
  subPath: string,
  url: URL,
  request: Request,
  now: () => number,
  completeFn: typeof complete,
  streamFn: StreamFn,
): Promise<Response | null> {
  // ---- Assessments ----
  if (subPath === '/v1/assessments' && request.method === 'GET') {
    const courseKey = validateCourseKey(url.searchParams.get('courseKey'))
    if (!courseKey) return Response.json({ error: 'Provide a valid courseKey in <track>/<course> format.' }, { status: 400 })
    const view = parseListView(url)
    if (!view) return Response.json({ error: INVALID_VIEW_ERROR }, { status: 400 })
    const ts = now()
    if (view === 'summary') {
      return Response.json({ courseKey, assessments: listAssessmentSummaries(orm, courseKey, ts) }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const rows = orm
      .select({ id: sidecarAssessments.id })
      .from(sidecarAssessments)
      .where(eq(sidecarAssessments.courseKey, courseKey))
      .orderBy(desc(sidecarAssessments.createdAt))
      .all()
    const assessments = rows
      .map((r) => loadAssessment(orm, r.id, ts))
      .filter((r): r is AssessmentRow => r !== null)
      .map((r) => buildAssessmentDetail(orm, r, ts))
    return Response.json({ courseKey, assessments }, { headers: { 'Cache-Control': 'no-store' } })
  }

  if (subPath === '/v1/assessments' && request.method === 'POST') {
    const body = (await readJson(request, LARGE_BODY_LIMIT)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Provide a valid JSON request body.' }, { status: 400 })
    }
    const courseKey = validateCourseKey(body.courseKey)
    if (!courseKey) return Response.json({ error: 'Provide a valid courseKey in <track>/<course> format.' }, { status: 400 })
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
      return Response.json({ error: 'Provide an assessment title up to 200 characters.' }, { status: 400 })
    }
    const mode = body.mode
    if (mode !== 'timed' && mode !== 'untimed') {
      return Response.json({ error: 'mode must be timed or untimed.' }, { status: 400 })
    }
    let durationSeconds: number | null = null
    if (mode === 'timed') {
      if (typeof body.durationSeconds !== 'number' || !Number.isInteger(body.durationSeconds) || body.durationSeconds < 60 || body.durationSeconds > 28800) {
        return Response.json({ error: 'Timed assessments require durationSeconds between 60 and 28800.' }, { status: 400 })
      }
      durationSeconds = body.durationSeconds
    }
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
      return Response.json({ error: 'Provide between 1 and 100 assessment items.' }, { status: 400 })
    }
    const parsedItems: { lessonKey: string; exerciseKey: string; contentHash: string; snapshot: ExerciseSnapshot }[] = []
    for (const rawItem of body.items) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        return Response.json({ error: 'Each assessment item must be an object.' }, { status: 400 })
      }
      const itemObj = rawItem as Record<string, unknown>
      const lessonKey = validateLessonKey(itemObj.lessonKey)
      if (lessonKey === null) return Response.json({ error: 'Invalid lessonKey in assessment item.' }, { status: 400 })
      const exerciseKey = validateExerciseKey(itemObj.exerciseKey)
      if (!exerciseKey) return Response.json({ error: 'Invalid exerciseKey in assessment item.' }, { status: 400 })
      const snap = parseExerciseSnapshot(itemObj.exerciseSnapshot)
      if ('error' in snap) return Response.json({ error: snap.error }, { status: 400 })
      parsedItems.push({ lessonKey, exerciseKey, contentHash: hashExerciseSnapshot(snap), snapshot: snap })
    }

    const id = crypto.randomUUID()
    const ts = now()
    orm.transaction((tx) => {
      tx.insert(sidecarAssessments)
        .values({
          id,
          courseKey,
          title: (body.title as string).trim(),
          mode,
          durationSeconds,
          status: 'planned',
          createdAt: ts,
          version: 0,
        })
        .run()
      parsedItems.forEach((item, position) => {
        tx.insert(sidecarAssessmentItems)
          .values({
            id: crypto.randomUUID(),
            assessmentId: id,
            position,
            lessonKey: item.lessonKey,
            exerciseKey: item.exerciseKey,
            contentHash: item.contentHash,
            exerciseSnapshot: JSON.stringify(item.snapshot),
          })
          .run()
      })
    })
    const row = loadAssessment(orm, id, ts)!
    return Response.json({ assessment: buildAssessmentDetail(orm, row, ts) }, { status: 201 })
  }

  const assessMatch = subPath.match(/^\/v1\/assessments\/([^/]+)(?:\/(start|answers|submit|feedback|correct))?$/)
  if (assessMatch) {
    const [, assessmentId, action] = assessMatch
    if (!UUID_RE.test(assessmentId)) return Response.json({ error: 'Assessment not found.' }, { status: 404 })
    const ts = now()
    const row = loadAssessment(orm, assessmentId, ts)
    if (!row) return Response.json({ error: 'Assessment not found.' }, { status: 404 })

    if (!action) {
      if (request.method !== 'GET') return Response.json({ error: 'Not found' }, { status: 404 })
      return Response.json({ assessment: buildAssessmentDetail(orm, row, ts) }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (request.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 })

    if (action === 'start') {
      const result = orm.transaction((tx) => {
        const current = tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, assessmentId)).get()!
        const effective =
          current.status === 'active' && current.mode === 'timed' && current.deadlineAt !== null && ts >= current.deadlineAt
            ? finalizeAssessmentRow(tx, current, 'expired', ts)
            : current
        if (effective.status === 'submitted' || effective.status === 'expired') return { status: 409 as const, row: effective }
        if (effective.status === 'active') return { status: 200 as const, row: effective }
        const deadlineAt = effective.mode === 'timed' && effective.durationSeconds !== null ? ts + effective.durationSeconds * 1000 : null
        tx.update(sidecarAssessments)
          .set({ status: 'active', startedAt: ts, deadlineAt, version: sql`${sidecarAssessments.version} + 1` })
          .where(and(eq(sidecarAssessments.id, assessmentId), eq(sidecarAssessments.status, 'planned')))
          .run()
        return { status: 200 as const, row: tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, assessmentId)).get()! }
      })
      if (result.status === 409) {
        return Response.json({ error: 'This assessment has already been finalized.', assessment: buildAssessmentDetail(orm, result.row, ts) }, { status: 409 })
      }
      return Response.json({ assessment: buildAssessmentDetail(orm, result.row, ts) })
    }

    const body = request.headers.get('content-type')?.toLowerCase().startsWith('application/json')
      ? ((await readJson(request, 65536)) as Record<string, unknown> | null)
      : {}
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Provide a valid JSON request body.' }, { status: 400 })
    }
    const expectedVersion = parseExpectedVersion(body.expectedVersion)
    if (expectedVersion === null) return Response.json({ error: 'expectedVersion must be a non-negative integer.' }, { status: 400 })

    if (action === 'answers') {
      if (typeof body.itemId !== 'string' || typeof body.answer !== 'string') {
        return Response.json({ error: 'Provide itemId and answer.' }, { status: 400 })
      }
      if (body.answer.length > 20000) {
        return Response.json({ error: 'Answers are limited to 20,000 characters.' }, { status: 400 })
      }
      const itemId = body.itemId
      const rawAnswer = body.answer
      const result = orm.transaction((tx) => {
        const raw = tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, assessmentId)).get()!
        const current =
          raw.status === 'active' && raw.mode === 'timed' && raw.deadlineAt !== null && ts >= raw.deadlineAt
            ? finalizeAssessmentRow(tx, raw, 'expired', ts)
            : raw
        if (current.status === 'expired') return { status: 409 as const, error: 'The assessment deadline passed. Answers were finalized.', row: current }
        if (current.status !== 'active') return { status: 409 as const, error: 'Start the assessment before saving answers.', row: current }
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          return { status: 409 as const, error: 'This assessment changed. Reload it.', row: current }
        }
        const item = tx
          .select()
          .from(sidecarAssessmentItems)
          .where(and(eq(sidecarAssessmentItems.id, itemId), eq(sidecarAssessmentItems.assessmentId, assessmentId)))
          .get()
        if (!item) return { status: 404 as const, error: 'Assessment item not found.' }
        const snap = JSON.parse(item.exerciseSnapshot) as ExerciseSnapshot
        const value = snap.type === 'multiple_choice' ? rawAnswer : rawAnswer.trim()
        if (snap.type === 'multiple_choice' && !snap.options.includes(value)) {
          return { status: 400 as const, error: 'Multiple-choice answer must match one option exactly.' }
        }
        tx.insert(sidecarAssessmentAnswers)
          .values({ assessmentId, itemId: item.id, answer: value, updatedAt: ts })
          .onConflictDoUpdate({
            target: [sidecarAssessmentAnswers.assessmentId, sidecarAssessmentAnswers.itemId],
            set: { answer: value, updatedAt: ts },
          })
          .run()
        tx.update(sidecarAssessments)
          .set({ version: sql`${sidecarAssessments.version} + 1` })
          .where(eq(sidecarAssessments.id, assessmentId))
          .run()
        return { status: 200 as const, row: tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, assessmentId)).get()! }
      })
      if (result.status === 404) return Response.json({ error: result.error }, { status: 404 })
      if (result.status === 400) return Response.json({ error: result.error }, { status: 400 })
      if (result.status === 409) {
        return Response.json({ error: result.error, assessment: buildAssessmentDetail(orm, result.row, ts) }, { status: 409 })
      }
      return Response.json({ assessment: buildAssessmentDetail(orm, result.row, ts) })
    }

    if (action === 'submit') {
      const result = orm.transaction((tx) => {
        const raw = tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, assessmentId)).get()!
        const current =
          raw.status === 'active' && raw.mode === 'timed' && raw.deadlineAt !== null && ts >= raw.deadlineAt
            ? finalizeAssessmentRow(tx, raw, 'expired', ts)
            : raw
        if (current.status === 'expired') return { status: 409 as const, error: 'The assessment deadline passed before submission.', row: current }
        if (current.status !== 'active') return { status: 409 as const, error: 'This assessment cannot be submitted in its current state.', row: current }
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          return { status: 409 as const, error: 'This assessment changed. Reload it.', row: current }
        }
        return { status: 200 as const, row: finalizeAssessmentRow(tx, current, 'submitted', ts) }
      })
      if (result.status === 409) {
        return Response.json({ error: result.error, assessment: buildAssessmentDetail(orm, result.row, ts) }, { status: 409 })
      }
      return Response.json({ assessment: buildAssessmentDetail(orm, result.row, ts) })
    }

    if (action === 'feedback') {
      if (typeof body.itemId !== 'string') return Response.json({ error: 'Choose an item for feedback.' }, { status: 400 })
      if (row.status !== 'submitted' && row.status !== 'expired') {
        return Response.json({ error: 'Submit the assessment before requesting feedback.' }, { status: 409 })
      }
      if (expectedVersion !== undefined && row.version !== expectedVersion) {
        return Response.json({ error: 'This assessment changed. Reload it.', assessment: buildAssessmentDetail(orm, row, ts) }, { status: 409 })
      }
        const item = orm
          .select()
          .from(sidecarAssessmentItems)
          .where(and(eq(sidecarAssessmentItems.id, body.itemId), eq(sidecarAssessmentItems.assessmentId, assessmentId)))
          .get()
        if (!item) return Response.json({ error: 'Assessment item not found.' }, { status: 404 })
        const snap = JSON.parse(item.exerciseSnapshot) as ExerciseSnapshot
        if (isDeterministicExerciseType(snap.type)) {
          return Response.json({ error: 'Deterministic exercise results do not need advisory feedback.' }, { status: 409 })
        }
      const resRow = orm
        .select()
        .from(sidecarAssessmentResults)
        .where(and(eq(sidecarAssessmentResults.assessmentId, assessmentId), eq(sidecarAssessmentResults.itemId, item.id)))
        .get()
      if (!resRow || !resRow.answer) return Response.json({ error: 'There is no saved answer for this item.' }, { status: 400 })
      const observedVersion = row.version
      let feedbackText: string
      try {
        feedbackText = await completeFn(practiceAdvisoryPrompt(snap, resRow.answer))
      } catch (error) {
        return Response.json({ error: error instanceof ModelError ? error.message : 'Model provider request failed.' }, { status: 502 })
      }
      const updated = orm.transaction((tx) => {
        const current = tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, assessmentId)).get()!
        if (current.version !== observedVersion) return { status: 409 as const, row: current }
        tx.update(sidecarAssessmentResults)
          .set({ feedback: feedbackText, advisory: 1 })
          .where(and(eq(sidecarAssessmentResults.assessmentId, assessmentId), eq(sidecarAssessmentResults.itemId, item.id)))
          .run()
        tx.update(sidecarAssessments)
          .set({ version: sql`${sidecarAssessments.version} + 1` })
          .where(and(eq(sidecarAssessments.id, assessmentId), eq(sidecarAssessments.version, observedVersion)))
          .run()
        return { status: 200 as const, row: tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, assessmentId)).get()! }
      })
      if (updated.status === 409) {
        return Response.json({ error: 'This assessment changed while feedback was running. Reload it.', assessment: buildAssessmentDetail(orm, updated.row, now()) }, { status: 409 })
      }
      return Response.json({ assessment: buildAssessmentDetail(orm, updated.row, now()) })
    }

    if (action === 'correct') {
      if (typeof body.itemId !== 'string' || typeof body.ownerNote !== 'string' || body.ownerNote.length > 10000) {
        return Response.json({ error: 'Provide itemId and ownerNote up to 10,000 characters.' }, { status: 400 })
      }
      const itemId = body.itemId
      const note = body.ownerNote.trim()
      const result = orm.transaction((tx) => {
        const raw = tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, assessmentId)).get()!
        const current =
          raw.status === 'active' && raw.mode === 'timed' && raw.deadlineAt !== null && ts >= raw.deadlineAt
            ? finalizeAssessmentRow(tx, raw, 'expired', ts)
            : raw
        if (current.status !== 'submitted' && current.status !== 'expired') {
          return { status: 409 as const, error: 'Submit the assessment before recording corrections.', row: current }
        }
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          return { status: 409 as const, error: 'This assessment changed. Reload it.', row: current }
        }
        const exists = tx
          .select({ id: sidecarAssessmentResults.id })
          .from(sidecarAssessmentResults)
          .where(and(eq(sidecarAssessmentResults.assessmentId, assessmentId), eq(sidecarAssessmentResults.itemId, itemId)))
          .get()
        if (!exists) return { status: 404 as const, error: 'Assessment item not found.' }
        tx.update(sidecarAssessmentResults)
          .set({ ownerNote: note })
          .where(and(eq(sidecarAssessmentResults.assessmentId, assessmentId), eq(sidecarAssessmentResults.itemId, itemId)))
          .run()
        tx.update(sidecarAssessments)
          .set({ version: sql`${sidecarAssessments.version} + 1` })
          .where(eq(sidecarAssessments.id, assessmentId))
          .run()
        return { status: 200 as const, row: tx.select().from(sidecarAssessments).where(eq(sidecarAssessments.id, assessmentId)).get()! }
      })
      if (result.status === 404) return Response.json({ error: result.error }, { status: 404 })
      if (result.status === 409) {
        return Response.json({ error: result.error, assessment: buildAssessmentDetail(orm, result.row, ts) }, { status: 409 })
      }
      return Response.json({ assessment: buildAssessmentDetail(orm, result.row, ts) })
    }
  }

  const tutorResponse = await handleTutor(orm, subPath, url, request, now, completeFn, streamFn)
  if (tutorResponse) return tutorResponse

  if (subPath === '/v1/review' && request.method === 'GET') {
    const rawCourse = url.searchParams.get('courseKey')
    let courseKey: string | null = null
    if (rawCourse !== null && rawCourse !== '') {
      courseKey = validateCourseKey(rawCourse)
      if (!courseKey) {
        return Response.json({ error: 'Provide a valid courseKey in <track>/<course> format.' }, { status: 400 })
      }
    }
    const onlyDue = url.searchParams.get('onlyDue') === '1' || url.searchParams.get('onlyDue') === 'true'
    const view = parseListView(url)
    if (!view) return Response.json({ error: INVALID_VIEW_ERROR }, { status: 400 })
    const queue =
      view === 'summary'
        ? buildReviewQueueSummary(orm, { courseKey, onlyDue, now: now() })
        : buildReviewQueue(orm, { courseKey, onlyDue, now: now() })
    return Response.json(queue, { headers: { 'Cache-Control': 'no-store' } })
  }

  if (subPath === '/v1/digest' && request.method === 'GET') {
    const rawCourse = url.searchParams.get('courseKey')
    let courseKey: string | null = null
    if (rawCourse !== null && rawCourse !== '') {
      courseKey = validateCourseKey(rawCourse)
      if (!courseKey) {
        return Response.json({ error: 'Provide a valid courseKey in <track>/<course> format.' }, { status: 400 })
      }
    }
    const digest = buildRecallDigest(orm, { courseKey, now: now() })
    return Response.json(digest, { headers: { 'Cache-Control': 'no-store' } })
  }

  return null
}
