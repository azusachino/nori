import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { createLearnerApi } from './api'
import { openDatabase } from './database'
import { hashContent } from './modules'

mkdirSync('.tmp/nori-modules', { recursive: true })
const directories: string[] = []
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })

let clock = 1_700_000_000_000

type Learner = ReturnType<typeof createLearnerApi>
type Item = { id: string; position: number; moduleId: string; type: string; prompt: string; options: string[]; answer?: string; explanation?: string; savedAnswer?: string; result?: { answer: string | null; correct: number | null; grading: string; feedback: string; advisory: boolean; ownerNote: string } | null }
type Detail = { id: string; status: string; version: number; mode: string; durationSeconds: number | null; startedAt: number | null; deadlineAt: number | null; submittedAt: number | null; finalizedAt: number | null; remainingMs: number | null; scope: { modules: { id: string; title: string; lessons: number; exercises: number }[]; lessonCount: number; exerciseCount: number }; items: Item[]; summary: { itemCount: number; answeredCount: number; deterministicTotal?: number; deterministicCorrect?: number; deterministicIncorrect?: number; unscoredCount?: number } }

function setup() {
  const directory = mkdtempSync(join('.tmp/nori-modules', 'assessment-'))
  directories.push(directory)
  const path = join(directory, 'assessment.sqlite')
  const database = openDatabase(path)
  const learner = createLearnerApi(database, () => clock)
  return { directory, path, database, learner }
}

function call(learner: Learner, path: string, body?: unknown) {
  return learner(new Request(`http://localhost:3000${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function detail(learner: Learner, courseId: string, assessmentId: string): Promise<Detail> {
  const response = await call(learner, `/api/courses/${courseId}/assessments/${assessmentId}`)
  expect(response.status).toBe(200)
  return json<{ assessment: Detail }>(response).then((body) => body.assessment)
}

function exercise(type: 'multiple_choice' | 'written' | 'code', prefix: string, index: number) {
  const id = crypto.randomUUID()
  return type === 'multiple_choice'
    ? { id, type, prompt: `${prefix} choice ${index}`, options: ['A', 'B'], answer: 'A', explanation: 'A explanation.' }
    : { id, type, prompt: `${prefix} ${type} ${index}`, options: [] as string[], answer: 'Reference answer', explanation: 'Reference explanation.' }
}

function moduleContent(title: string, prefix: string) {
  return { title, lessons: [{ title: `${prefix} lesson`, body: 'Lesson body.' }], exercises: [exercise('multiple_choice', prefix, 1), exercise('written', prefix, 2), exercise('code', prefix, 3)] }
}

function insertModule(database: Database, courseId: string, position: number, accepted: number, content: ReturnType<typeof moduleContent>) {
  const id = crypto.randomUUID()
  database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, courseId, position, JSON.stringify(content), accepted, Date.now()])
  return id
}

async function createCourse(learner: Learner) {
  const response = await call(learner, '/api/courses', { title: `Assessment ${crypto.randomUUID()}`, goal: 'Check understanding.' })
  expect(response.status).toBe(201)
  return ((await json<{ id: string }>(response))).id
}

async function createAssessment(learner: Learner, courseId: string, body: Record<string, unknown>) {
  const response = await call(learner, `/api/courses/${courseId}/assessments`, body)
  return { response, body: await json<{ assessment: Detail }>(response) }
}

function modelReturning(text: string, during?: () => void) {
  const original = globalThis.fetch
  process.env.NORI_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
  process.env.NORI_LLM_MODEL = 'assessment-test'
  globalThis.fetch = (async () => {
    during?.()
    return Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })
  }) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
    delete process.env.NORI_LLM_BASE_URL
    delete process.env.NORI_LLM_MODEL
  }
}

describe('assessments', () => {
  test('selects multiple modules, shows scope, resumes a timed deadline and freezes at the deadline boundary', async () => {
    clock = 1_700_000_000_000
    const { path, database, learner } = setup()
    let current = database
    let api = learner
    try {
      const courseId = await createCourse(api)
      const first = moduleContent('Module one', 'first')
      const second = moduleContent('Module two', 'second')
      const firstId = insertModule(current, courseId, 1, 1, first)
      const secondId = insertModule(current, courseId, 2, 1, second)
      const created = await createAssessment(api, courseId, { title: 'Midpoint check', mode: 'timed', durationSeconds: 60, moduleIds: [firstId, secondId] })
      expect(created.response.status).toBe(201)
      const planned = created.body.assessment
      expect(planned.status).toBe('planned')
      expect(planned.scope.modules.map((module) => module.title)).toEqual(['Module one', 'Module two'])
      expect(planned.scope.lessonCount).toBe(2)
      expect(planned.scope.exerciseCount).toBe(6)
      expect(planned.items).toHaveLength(6)
      expect(planned.items[0]!.answer).toBeUndefined()
      expect(planned.items[0]!.explanation).toBeUndefined()
      expect(planned.deadlineAt).toBeNull()

      const listed = await call(api, `/api/courses/${courseId}/assessments`)
      expect(listed.status).toBe(200)
      expect(((await json<{ assessments: Detail[] }>(listed)).assessments)).toHaveLength(1)

      const started = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/start`, {})
      expect(started.status).toBe(200)
      let state = (await json<{ assessment: Detail }>(started)).assessment
      expect(state.status).toBe('active')
      expect(state.startedAt).toBe(clock)
      expect(state.deadlineAt).toBe(clock + 60000)
      expect(state.remainingMs).toBe(60000)

      const resumedStart = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/start`, {})
      expect(resumedStart.status).toBe(200)
      const resumedAgain = (await json<{ assessment: Detail }>(resumedStart)).assessment
      expect(resumedAgain.startedAt).toBe(state.startedAt)
      expect(resumedAgain.deadlineAt).toBe(state.deadlineAt)
      expect(resumedAgain.version).toBe(state.version)

      const saved = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/answers`, { itemId: state.items[0]!.id, answer: 'A', expectedVersion: state.version })
      expect(saved.status).toBe(200)
      state = (await json<{ assessment: Detail }>(saved)).assessment
      expect(state.items[0]!.savedAnswer).toBe('A')
      const savedWritten = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/answers`, { itemId: state.items[1]!.id, answer: 'First written answer', expectedVersion: state.version })
      expect(savedWritten.status).toBe(200)
      state = (await json<{ assessment: Detail }>(savedWritten)).assessment
      const staleAnswer = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/answers`, { itemId: state.items[2]!.id, answer: 'B', expectedVersion: 1 })
      expect(staleAnswer.status).toBe(409)
      expect((await detail(api, courseId, planned.id)).version).toBe(state.version)

      // Restart: the absolute deadline and saved answers survive; no wall-clock duration is recomputed.
      current.close()
      current = openDatabase(path)
      api = createLearnerApi(current, () => clock)
      const resumed = await detail(api, courseId, planned.id)
      expect(resumed.status).toBe('active')
      expect(resumed.deadlineAt).toBe(clock + 60000)
      expect(resumed.items[0]!.savedAnswer).toBe('A')
      expect(resumed.items[1]!.savedAnswer).toBe('First written answer')

      clock = resumed.deadlineAt! - 1
      const lastSecond = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/answers`, { itemId: resumed.items[2]!.id, answer: 'B', expectedVersion: resumed.version })
      expect(lastSecond.status).toBe(200)

      clock = resumed.deadlineAt!
      const expired = await detail(api, courseId, planned.id)
      expect(expired.status).toBe('expired')
      expect(expired.submittedAt).toBeNull()
      expect(expired.deadlineAt).toBe(resumed.deadlineAt)
      expect(expired.finalizedAt).toBe(resumed.deadlineAt)
      expect(expired.remainingMs).toBeNull()
      expect(expired.summary.deterministicTotal).toBe(2)
      expect(expired.summary.deterministicCorrect).toBe(1)
      expect(expired.summary.deterministicIncorrect).toBe(1)
      expect(expired.summary.unscoredCount).toBe(4)
      expect(expired.items[0]!.answer).toBe('A')
      expect(expired.items[0]!.explanation).toBe('A explanation.')
      expect(expired.items[0]!.result?.correct).toBe(1)
      expect(expired.items[1]!.result?.correct).toBeNull()
      expect(expired.items[1]!.result?.grading).toBe('unscored')
      expect(expired.items[2]!.result).toMatchObject({ answer: 'B', correct: null, grading: 'unscored' })
      expect(expired.items[3]!.result).toMatchObject({ answer: null, correct: 0, grading: 'deterministic' })
      expect(expired.items[4]!.result).toMatchObject({ answer: null, correct: null, grading: 'unscored' })

      expect((await call(api, `/api/courses/${courseId}/assessments/${planned.id}/answers`, { itemId: expired.items[2]!.id, answer: 'A' })).status).toBe(409)
      expect((await call(api, `/api/courses/${courseId}/assessments/${planned.id}/submit`, {})).status).toBe(409)

      const frozenVersion = expired.version
      clock += 5000
      const repeated = await detail(api, courseId, planned.id)
      expect(repeated.status).toBe('expired')
      expect(repeated.version).toBe(frozenVersion)
      expect(repeated.finalizedAt).toBe(resumed.deadlineAt)
      expect(repeated.summary.answeredCount).toBe(3)
      const stored = current.query('SELECT status, submitted_at, deadline_at, finalized_at FROM assessments WHERE id = ?').get(planned.id) as { status: string; submitted_at: number | null; deadline_at: number; finalized_at: number }
      expect(stored).toEqual({ status: 'expired', submitted_at: null, deadline_at: resumed.deadlineAt!, finalized_at: resumed.deadlineAt! })
      expect(current.query('SELECT COUNT(*) AS count FROM assessment_results WHERE assessment_id = ?').get(planned.id)).toEqual({ count: 6 })
    } finally { current.close() }
  })

  test('untimed assessments persist explicit submission, advisory feedback and corrections without touching attempts', async () => {
    clock = 1_700_100_000_000
    const { path, database, learner } = setup()
    let current = database
    let api = learner
    try {
      const courseId = await createCourse(api)
      const content = moduleContent('Module one', 'first')
      const moduleId = insertModule(current, courseId, 1, 1, content)
      const attemptId = crypto.randomUUID()
      current.run('INSERT INTO attempts (id, module_id, exercise_index, answer, feedback, correct, created_at, owner_note, exercise_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [attemptId, moduleId, 0, 'A', 'Existing feedback', 1, clock, 'Existing correction', content.exercises[0]!.id])
      const moduleBefore = current.query('SELECT content FROM modules WHERE id = ?').get(moduleId) as { content: string }
      const attemptsBefore = current.query('SELECT COUNT(*) AS count FROM attempts').get()

      const created = await createAssessment(api, courseId, { mode: 'untimed', moduleIds: [moduleId] })
      expect(created.response.status).toBe(201)
      const planned = created.body.assessment
      const started = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/start`, {})
      let state = (await json<{ assessment: Detail }>(started)).assessment
      expect(state.deadlineAt).toBeNull()
      expect(state.remainingMs).toBeNull()
      clock += 365 * 24 * 60 * 60 * 1000
      state = await detail(api, courseId, planned.id)
      expect(state.status).toBe('active')

      const saved = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/answers`, { itemId: state.items[1]!.id, answer: 'My written answer', expectedVersion: state.version })
      state = (await json<{ assessment: Detail }>(saved)).assessment
      expect((await call(api, `/api/courses/${courseId}/assessments/${planned.id}/submit`, { expectedVersion: 1 })).status).toBe(409)
      const submitted = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/submit`, { expectedVersion: state.version })
      expect(submitted.status).toBe(200)
      state = (await json<{ assessment: Detail }>(submitted)).assessment
      expect(state.status).toBe('submitted')
      expect(state.submittedAt).toBe(clock)
      expect(state.finalizedAt).toBe(clock)
      const submittedAt = state.submittedAt
      expect((await call(api, `/api/courses/${courseId}/assessments/${planned.id}/answers`, { itemId: state.items[1]!.id, answer: 'Late' })).status).toBe(409)

      const restore = modelReturning('Advisory: add an example.')
      let feedbackState!: Detail
      try {
        const feedback = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/feedback`, { itemId: state.items[1]!.id, expectedVersion: state.version })
        expect(feedback.status).toBe(200)
        feedbackState = (await json<{ assessment: Detail }>(feedback)).assessment
      } finally { restore() }
      const writtenResult = feedbackState.items[1]!.result!
      expect(writtenResult.feedback).toBe('Advisory: add an example.')
      expect(writtenResult.advisory).toBe(true)
      expect(writtenResult.correct).toBeNull()
      expect(writtenResult.grading).toBe('unscored')

      const corrected = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/correct`, { itemId: state.items[1]!.id, note: 'The reference is also valid here.', expectedVersion: feedbackState.version })
      expect(corrected.status).toBe(200)
      const correctedState = (await json<{ assessment: Detail }>(corrected)).assessment
      expect(correctedState.items[1]!.result?.ownerNote).toBe('The reference is also valid here.')
      expect((await call(api, `/api/courses/${courseId}/assessments/${planned.id}/correct`, { itemId: state.items[1]!.id, note: 'Stale correction', expectedVersion: feedbackState.version })).status).toBe(409)
      expect((await call(api, `/api/courses/${courseId}/assessments/${planned.id}/feedback`, { itemId: state.items[0]!.id })).status).toBe(409)

      // A correction that lands while the model is running must not be overwritten by late feedback.
      const late = modelReturning('Late overwrite', () => { current.run('UPDATE assessments SET version = version + 1 WHERE id = ?', [planned.id]) })
      try {
        const lateFeedback = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/feedback`, { itemId: state.items[1]!.id, expectedVersion: correctedState.version })
        expect(lateFeedback.status).toBe(409)
      } finally { late() }
      const afterLate = await detail(api, courseId, planned.id)
      expect(afterLate.items[1]!.result?.feedback).toBe('Advisory: add an example.')
      expect(afterLate.items[1]!.result?.ownerNote).toBe('The reference is also valid here.')

      current.close()
      current = openDatabase(path)
      api = createLearnerApi(current, () => clock)
      const restarted = await detail(api, courseId, planned.id)
      expect(restarted.status).toBe('submitted')
      expect(restarted.submittedAt).toBe(submittedAt)
      expect(restarted.items[1]!.result?.feedback).toBe('Advisory: add an example.')
      expect(restarted.items[1]!.result?.ownerNote).toBe('The reference is also valid here.')
      expect(restarted.items[2]!.result).toMatchObject({ correct: null, grading: 'unscored' })
      expect(current.query('SELECT COUNT(*) AS count FROM attempts').get()).toEqual(attemptsBefore)
      expect(current.query('SELECT id, answer, feedback, correct, owner_note, exercise_id FROM attempts WHERE id = ?').get(attemptId)).toEqual({ id: attemptId, answer: 'A', feedback: 'Existing feedback', correct: 1, owner_note: 'Existing correction', exercise_id: content.exercises[0]!.id })
      expect(current.query('SELECT content FROM modules WHERE id = ?').get(moduleId)).toEqual(moduleBefore)
      expect(hashContent((current.query('SELECT content FROM modules WHERE id = ?').get(moduleId) as { content: string }).content)).toBe(hashContent(moduleBefore.content))
    } finally { current.close() }
  })

  test('expiry is finalized once after restart with submittedAt null and a stable observed finalizedAt', async () => {
    clock = 1_700_200_000_000
    const { path, database, learner } = setup()
    let current = database
    let api = learner
    try {
      const courseId = await createCourse(api)
      const moduleId = insertModule(current, courseId, 1, 1, moduleContent('Module one', 'first'))
      const created = await createAssessment(api, courseId, { mode: 'timed', durationSeconds: 30, moduleIds: [moduleId] })
      const planned = created.body.assessment
      const started = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/start`, {})
      let state = (await json<{ assessment: Detail }>(started)).assessment
      const saved = await call(api, `/api/courses/${courseId}/assessments/${planned.id}/answers`, { itemId: state.items[0]!.id, answer: 'A', expectedVersion: state.version })
      expect(saved.status).toBe(200)
      const deadline = state.deadlineAt!
      current.close()

      clock = deadline
      current = openDatabase(path)
      api = createLearnerApi(current, () => clock)
      const firstReview = await detail(api, courseId, planned.id)
      expect(firstReview.status).toBe('expired')
      expect(firstReview.submittedAt).toBeNull()
      expect(firstReview.deadlineAt).toBe(deadline)
      expect(firstReview.finalizedAt).toBe(clock)
      const version = firstReview.version
      expect(firstReview.items[0]!.result).toMatchObject({ answer: 'A', correct: 1, grading: 'deterministic' })

      clock += 60000
      const secondReview = await detail(api, courseId, planned.id)
      expect(secondReview.version).toBe(version)
      expect(secondReview.finalizedAt).toBe(deadline)
      expect(secondReview.items[0]!.result).toEqual(firstReview.items[0]!.result)
      expect(current.query('SELECT COUNT(*) AS count FROM assessment_results WHERE assessment_id = ?').get(planned.id)).toEqual({ count: 3 })
    } finally { current.close() }
  })

  test('submitting at the exact deadline finalizes as expired rather than submitted', async () => {
    clock = 1_700_250_000_000
    const { database, learner } = setup()
    try {
      const courseId = await createCourse(learner)
      const moduleId = insertModule(database, courseId, 1, 1, moduleContent('Module one', 'first'))
      const created = await createAssessment(learner, courseId, { mode: 'timed', durationSeconds: 10, moduleIds: [moduleId] })
      const planned = created.body.assessment
      const started = await call(learner, `/api/courses/${courseId}/assessments/${planned.id}/start`, {})
      const state = (await json<{ assessment: Detail }>(started)).assessment
      clock = state.deadlineAt!
      const submitted = await call(learner, `/api/courses/${courseId}/assessments/${planned.id}/submit`, {})
      expect(submitted.status).toBe(409)
      const expired = (await json<{ assessment: Detail }>(submitted)).assessment
      expect(expired.status).toBe('expired')
      expect(expired.submittedAt).toBeNull()
      expect(expired.deadlineAt).toBe(state.deadlineAt)
      expect(expired.finalizedAt).toBe(clock)
      expect(database.query('SELECT status, submitted_at FROM assessments WHERE id = ?').get(planned.id)).toEqual({ status: 'expired', submitted_at: null })
      expect((await call(learner, `/api/courses/${courseId}/assessments/${planned.id}/answers`, { itemId: state.items[0]!.id, answer: 'A' })).status).toBe(409)
    } finally { database.close() }
  })

  test('rejects unaccepted modules and invalid exercise selection while snapshotting a subset', async () => {
    clock = 1_700_300_000_000
    const { database, learner } = setup()
    try {
      const courseId = await createCourse(learner)
      const accepted = moduleContent('Accepted module', 'accepted')
      const draft = moduleContent('Draft module', 'draft')
      const acceptedId = insertModule(database, courseId, 1, 1, accepted)
      const draftId = insertModule(database, courseId, 2, 0, draft)
      expect((await createAssessment(learner, courseId, { mode: 'untimed', moduleIds: [draftId] })).response.status).toBe(409)
      expect((await createAssessment(learner, courseId, { mode: 'untimed', moduleIds: [acceptedId], exerciseIds: ['00000000-0000-4000-8000-000000000000'] })).response.status).toBe(400)
      const created = await createAssessment(learner, courseId, { mode: 'untimed', moduleIds: [acceptedId], exerciseIds: [accepted.exercises[0]!.id, accepted.exercises[2]!.id] })
      expect(created.response.status).toBe(201)
      const assessment = created.body.assessment
      expect(assessment.scope.exerciseCount).toBe(2)
      expect(assessment.items.map((item) => item.type)).toEqual(['multiple_choice', 'code'])
      expect(assessment.items.every((item) => item.answer === undefined)).toBe(true)
      expect((await createAssessment(learner, courseId, { mode: 'timed', durationSeconds: 0, moduleIds: [acceptedId] })).response.status).toBe(400)
      expect((await createAssessment(learner, courseId, { mode: 'untimed', moduleIds: [] })).response.status).toBe(400)
    } finally { database.close() }
  })
})
