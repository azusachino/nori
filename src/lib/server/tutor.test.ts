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

let clock = 1_700_500_000_000
type Learner = ReturnType<typeof createLearnerApi>

type AttemptView = { id: string; exerciseId: string | null; exerciseIndex: number; prompt: string; answer: string; feedback: string; correct: number | null; ownerNote: string }
type HistoryTurn = { id: string; role: 'user' | 'assistant'; content: string; createdAt: number }
type ContextView = { moduleId: string; moduleTitle: string; lessonIndex: number; lessonTitle: string; lessonText: string; attempts: AttemptView[]; sourceIds: string[]; contextLimit: number; contextChars: number; historyTurnsIncluded: number; historyTurnsDropped: number; history: HistoryTurn[]; conversationRevision: number }
type TurnView = { id: string; role: 'user' | 'assistant'; content: string; createdAt: number; context: ContextView }
type ProposalView = { id: string; content: string; createdAt: number; draft: { id: string; position: number; contentHash: string } | null }
type TutorResponse = { reply: string; context: ContextView; turns: [TurnView, TurnView]; proposal: ProposalView | null; conversationRevision: number }
type HistoryResponse = { moduleId: string; lessonIndex: number; lessonTitle: string; contextLimit: number; revision: number; turns: TurnView[]; proposals: ProposalView[] }

type ModuleContent = { title: string; lessons: { title: string; body: string }[]; exercises: { id: string; type: 'multiple_choice' | 'written' | 'code'; prompt: string; options: string[]; answer: string; explanation: string }[] }

function setup() {
  const directory = mkdtempSync(join('.tmp/nori-modules', 'tutor-'))
  directories.push(directory)
  const path = join(directory, 'tutor.sqlite')
  const database = openDatabase(path)
  const learner = createLearnerApi(database, () => clock)
  return { path, database, learner }
}

function call(learner: Learner, path: string, body?: unknown) {
  return learner(new Request(`http://localhost:3000${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}

async function json<T>(response: Response): Promise<T> { return await response.json() as T }

async function createCourse(learner: Learner) {
  const response = await call(learner, '/api/courses', { title: `Tutor ${crypto.randomUUID()}`, goal: 'Learn with context.' })
  expect(response.status).toBe(201)
  return (await json<{ id: string }>(response)).id
}

function moduleContent(title: string, prefix: string): ModuleContent {
  return {
    title, lessons: [{ title: `${prefix} lesson zero`, body: `${prefix} body zero.` }, { title: `${prefix} lesson one`, body: `${prefix} body one.` }],
    exercises: [
      { id: crypto.randomUUID(), type: 'multiple_choice', prompt: `${prefix} choice`, options: ['A', 'B'], answer: 'A', explanation: 'A.' },
      { id: crypto.randomUUID(), type: 'written', prompt: `${prefix} written`, options: [], answer: 'Reference', explanation: 'Reason.' },
      { id: crypto.randomUUID(), type: 'code', prompt: `${prefix} code`, options: [], answer: 'Reference code', explanation: 'Code reason.' },
    ],
  }
}

function insertModule(database: Database, courseId: string, position: number, accepted: number, content: ModuleContent) {
  const id = crypto.randomUUID()
  database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, courseId, position, JSON.stringify(content), accepted, clock])
  return id
}

function insertAttempt(database: Database, moduleId: string, exerciseId: string, index: number, answer: string, feedback: string, correct: number | null, ownerNote = '') {
  const id = crypto.randomUUID()
  database.run('INSERT INTO attempts (id, module_id, exercise_index, answer, feedback, correct, created_at, owner_note, exercise_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, moduleId, index, answer, feedback, correct, clock, ownerNote, exerciseId])
  return id
}

async function tutor(learner: Learner, courseId: string, body: Record<string, unknown>) {
  const response = await call(learner, `/api/courses/${courseId}/tutor`, body)
  return { response, body: await json<TutorResponse>(response) }
}

async function history(learner: Learner, courseId: string, moduleId: string, lessonIndex: number) {
  const response = await call(learner, `/api/courses/${courseId}/tutor?moduleId=${moduleId}&lessonIndex=${lessonIndex}`)
  return { response, body: await json<HistoryResponse>(response) }
}

type CapturedRequest = { model?: string; messages: { role: string; content: string }[] }
function modelCapture(reply: string, during?: () => void) {
  const original = globalThis.fetch
  const requests: CapturedRequest[] = []
  process.env.NORI_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
  process.env.NORI_LLM_MODEL = 'tutor-test'
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as CapturedRequest
    requests.push(request)
    during?.()
    return Response.json({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] })
  }) as unknown as typeof fetch
  return { requests, restore: () => { globalThis.fetch = original; delete process.env.NORI_LLM_BASE_URL; delete process.env.NORI_LLM_MODEL } }
}

describe('contextual tutor', () => {
  test('discloses and sends only the chosen lesson and attempts, persists per lesson, and includes prior turns after restart', async () => {
    clock = 1_700_500_000_000
    const { path, database, learner } = setup()
    let current = database
    let api = learner
    try {
      const courseId = await createCourse(api)
      const content = moduleContent('Tutor module', 'tutor')
      const moduleId = insertModule(current, courseId, 1, 1, content)
      const other = moduleContent('Other module', 'other')
      const otherId = insertModule(current, courseId, 2, 1, other)
      const selectedA = content.exercises[0]!
      const selectedB = content.exercises[1]!
      const attemptA = insertAttempt(current, moduleId, selectedA.id, 0, 'A', 'Correct. A.', 1, 'I want more detail.')
      const attemptB = insertAttempt(current, moduleId, selectedB.id, 1, 'My written answer', 'Add an example.', null)
      const otherAttempt = insertAttempt(current, otherId, other.exercises[0]!.id, 0, 'A', 'Other feedback.', 1)
      current.run('INSERT INTO sources (id, course_id, name, content, text, created_at) VALUES (?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), courseId, 'secret-source.md', new Uint8Array([1]), 'UNSELECTED SOURCE TEXT', clock])

      const firstModel = modelCapture('Here is help with the selected attempt.')
      let first: TutorResponse
      try {
        const result = await tutor(api, courseId, { moduleId, lessonIndex: 1, attemptIds: [attemptA], message: 'Explain this attempt.' })
        expect(result.response.status).toBe(200)
        first = result.body
      } finally { firstModel.restore() }
      expect(first.reply).toBe('Here is help with the selected attempt.')
      expect(first.context.moduleId).toBe(moduleId)
      expect(first.context.lessonIndex).toBe(1)
      expect(first.context.lessonTitle).toBe('tutor lesson one')
      expect(first.context.lessonText).toBe('tutor body one.')
      expect(first.context.attempts.map((attempt) => attempt.id)).toEqual([attemptA])
      expect(first.context.attempts[0]).toMatchObject({ answer: 'A', feedback: 'Correct. A.', correct: 1, ownerNote: 'I want more detail.', prompt: selectedA.prompt })
      expect(first.context.sourceIds).toEqual([])
      expect(first.context.contextLimit).toBe(120000)
      expect(first.context.history).toEqual([])
      expect(first.context.historyTurnsIncluded).toBe(0)
      expect(first.context.conversationRevision).toBe(0)

      const captured = firstModel.requests[0]!
      expect(captured.messages).toHaveLength(3)
      expect(captured.messages[0]!.content).toContain('Use only the supplied lesson text')
      expect(captured.messages[0]!.content).toContain('Prior turns may repeat material discussed earlier')
      expect(captured.messages[1]!.content).toContain('tutor body one.')
      expect(captured.messages[1]!.content).toContain(attemptA)
      expect(captured.messages[1]!.content).toContain('I want more detail.')
      expect(captured.messages[1]!.content).not.toContain('tutor body zero.')
      expect(captured.messages[1]!.content).not.toContain(attemptB)
      expect(captured.messages[1]!.content).not.toContain(otherAttempt)
      expect(captured.messages[1]!.content).not.toContain('UNSELECTED SOURCE TEXT')
      expect(captured.messages[2]!.content).toBe('Explain this attempt.')
      expect(first.context.contextChars).toBe(captured.messages.reduce((total, message) => total + message.content.length, 0))

      const stored = await history(api, courseId, moduleId, 1)
      expect(stored.response.status).toBe(200)
      expect(stored.body.turns).toHaveLength(2)
      expect(stored.body.turns.map((turn) => turn.role)).toEqual(['user', 'assistant'])
      expect(stored.body.turns[1]!.context.attempts[0]!.id).toBe(attemptA)
      expect(stored.body.revision).toBe(2)

      const secondModel = modelCapture('Follow-up answer.')
      let second: TutorResponse
      try {
        const result = await tutor(api, courseId, { moduleId, lessonIndex: 1, attemptIds: [attemptB], message: 'What about this one?' })
        expect(result.response.status).toBe(200)
        second = result.body
      } finally { secondModel.restore() }
      expect(second.context.attempts.map((attempt) => attempt.id)).toEqual([attemptB])
      expect(second.context.history.map((turn) => turn.id)).toEqual(stored.body.turns.map((turn) => turn.id))
      expect(second.context.history.map((turn) => turn.content)).toEqual(stored.body.turns.map((turn) => turn.content))
      expect(second.context.historyTurnsIncluded).toBe(2)
      expect(second.context.conversationRevision).toBe(2)
      const secondCaptured = secondModel.requests[0]!
      expect(secondCaptured.messages).toHaveLength(5)
      expect(secondCaptured.messages[2]!.content).toBe('Explain this attempt.')
      expect(secondCaptured.messages[3]!.content).toBe('Here is help with the selected attempt.')
      expect(secondCaptured.messages[4]!.content).toBe('What about this one?')
      expect(secondCaptured.messages[1]!.content).not.toContain(attemptA)

      current.close()
      current = openDatabase(path)
      api = createLearnerApi(current, () => clock)
      const restarted = await history(api, courseId, moduleId, 1)
      expect(restarted.body.turns).toHaveLength(4)
      expect(restarted.body.turns[0]!.context.attempts[0]!.id).toBe(attemptA)
      expect(restarted.body.turns[3]!.context.attempts[0]!.id).toBe(attemptB)
      const otherLesson = await history(api, courseId, moduleId, 0)
      expect(otherLesson.body.turns).toHaveLength(0)
      expect((await call(api, `/api/courses/${courseId}/tutor?moduleId=${moduleId}&lessonIndex=9`)).status).toBe(404)
    } finally { current.close() }
  })

  test('rejects missing, mismatched and stale references without writing turns', async () => {
    clock = 1_700_600_000_000
    const { database, learner } = setup()
    try {
      const courseId = await createCourse(learner)
      const content = moduleContent('Accepted module', 'accepted')
      const moduleId = insertModule(database, courseId, 1, 1, content)
      const draft = moduleContent('Draft module', 'draft')
      const draftId = insertModule(database, courseId, 2, 0, draft)
      const attempt = insertAttempt(database, moduleId, content.exercises[0]!.id, 0, 'A', 'Feedback.', 1)
      const draftAttempt = insertAttempt(database, draftId, draft.exercises[0]!.id, 0, 'A', 'Draft feedback.', 1)
      const otherCourse = await createCourse(learner)
      const otherContent = moduleContent('Foreign module', 'foreign')
      const foreignId = insertModule(database, otherCourse, 1, 1, otherContent)
      const foreignAttempt = insertAttempt(database, foreignId, otherContent.exercises[0]!.id, 0, 'A', 'Foreign.', 1)

      expect((await tutor(learner, courseId, { moduleId: draftId, lessonIndex: 0, message: 'Draft?' })).response.status).toBe(409)
      expect((await tutor(learner, courseId, { moduleId: foreignId, lessonIndex: 0, message: 'Foreign?' })).response.status).toBe(404)
      expect((await tutor(learner, courseId, { moduleId, lessonIndex: -1, message: 'Bad?' })).response.status).toBe(400)
      expect((await tutor(learner, courseId, { moduleId, lessonIndex: 1.5, message: 'Bad?' })).response.status).toBe(400)
      expect((await tutor(learner, courseId, { moduleId, lessonIndex: 9, message: 'Bad?' })).response.status).toBe(404)
      expect((await tutor(learner, courseId, { moduleId, lessonIndex: 0, attemptIds: [draftAttempt], message: 'Wrong module?' })).response.status).toBe(404)
      expect((await tutor(learner, courseId, { moduleId, lessonIndex: 0, attemptIds: [foreignAttempt], message: 'Wrong course?' })).response.status).toBe(404)
      expect((await tutor(learner, courseId, { moduleId, lessonIndex: 0, attemptIds: [attempt, attempt], message: 'Duplicate?' })).response.status).toBe(400)
      expect((await tutor(learner, courseId, { moduleId, lessonIndex: 0, attemptIds: ['nope'], message: 'Malformed?' })).response.status).toBe(400)
      expect((await tutor(learner, courseId, { moduleId, lessonIndex: 0, attemptIds: [attempt], message: '   ' })).response.status).toBe(400)
      expect((await call(learner, `/api/courses/${courseId}/tutor?moduleId=${foreignId}&lessonIndex=0`)).status).toBe(404)
      expect(database.query('SELECT COUNT(*) AS count FROM tutor_turns').get()).toEqual({ count: 0 })
      expect(database.query('SELECT COUNT(*) AS count FROM tutor_proposals').get()).toEqual({ count: 0 })
    } finally { database.close() }
  })

  test('provider failure preserves prior history and never mutates modules, drafts or attempts', async () => {
    clock = 1_700_700_000_000
    const { database, learner } = setup()
    try {
      const courseId = await createCourse(learner)
      const acceptedContent = moduleContent('Accepted module', 'accepted')
      const acceptedId = insertModule(database, courseId, 1, 1, acceptedContent)
      const draftContent = moduleContent('Draft module', 'draft')
      const draftId = insertModule(database, courseId, 2, 0, draftContent)
      const attempt = insertAttempt(database, acceptedId, acceptedContent.exercises[0]!.id, 0, 'A', 'Feedback.', 1)
      const good = modelCapture('First answer.')
      try {
        expect((await tutor(learner, courseId, { moduleId: acceptedId, lessonIndex: 0, attemptIds: [attempt], message: 'First question.' })).response.status).toBe(200)
      } finally { good.restore() }
      const turnsBefore = database.query('SELECT id, role, content, context FROM tutor_turns ORDER BY rowid').all()
      const acceptedBefore = database.query('SELECT content FROM modules WHERE id = ?').get(acceptedId)
      const draftBefore = database.query('SELECT content FROM modules WHERE id = ?').get(draftId)
      const attemptsBefore = database.query('SELECT id, answer, feedback, correct, owner_note FROM attempts ORDER BY rowid').all()

      const original = globalThis.fetch
      process.env.NORI_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
      process.env.NORI_LLM_MODEL = 'tutor-test'
      globalThis.fetch = (async () => Response.json({ error: 'provider down' }, { status: 500 })) as unknown as typeof fetch
      try {
        const failed = await tutor(learner, courseId, { moduleId: acceptedId, lessonIndex: 0, attemptIds: [attempt], message: 'Second question.' })
        expect(failed.response.status).toBe(502)
      } finally {
        globalThis.fetch = original
        delete process.env.NORI_LLM_BASE_URL
        delete process.env.NORI_LLM_MODEL
      }
      expect(database.query('SELECT id, role, content, context FROM tutor_turns ORDER BY rowid').all()).toEqual(turnsBefore)
      expect(database.query('SELECT content FROM modules WHERE id = ?').get(acceptedId)).toEqual(acceptedBefore)
      expect(database.query('SELECT content FROM modules WHERE id = ?').get(draftId)).toEqual(draftBefore)
      expect(database.query('SELECT id, answer, feedback, correct, owner_note FROM attempts ORDER BY rowid').all()).toEqual(attemptsBefore)
      const stored = await history(learner, courseId, acceptedId, 0)
      expect(stored.body.turns).toHaveLength(2)
    } finally { database.close() }
  })

  test('persists proposals separately and re-checks draft identity after the model call', async () => {
    clock = 1_700_800_000_000
    const { database, learner } = setup()
    try {
      const courseId = await createCourse(learner)
      const accepted = moduleContent('Accepted module', 'accepted')
      const acceptedId = insertModule(database, courseId, 1, 1, accepted)
      const draft = moduleContent('Draft module', 'draft')
      const draftId = insertModule(database, courseId, 2, 0, draft)
      const attempt = insertAttempt(database, acceptedId, accepted.exercises[0]!.id, 0, 'A', 'Feedback.', 1)
      const draftRow = database.query('SELECT content FROM modules WHERE id = ?').get(draftId) as { content: string }
      const acceptedRow = database.query('SELECT content FROM modules WHERE id = ?').get(acceptedId) as { content: string }
      const draftHash = hashContent(draftRow.content)

      const model = modelCapture('PROPOSAL: add a worked example to the next module.')
      let proposalResponse: TutorResponse
      try {
        const result = await tutor(learner, courseId, { moduleId: acceptedId, lessonIndex: 0, attemptIds: [attempt], message: 'Suggest an improvement.', proposal: true, expectedDraftContentHash: draftHash })
        expect(result.response.status).toBe(200)
        proposalResponse = result.body
      } finally { model.restore() }
      expect(proposalResponse.proposal?.content).toBe('PROPOSAL: add a worked example to the next module.')
      expect(proposalResponse.proposal?.draft).toEqual({ id: draftId, position: 2, contentHash: draftHash })
      expect(database.query('SELECT COUNT(*) AS count FROM tutor_proposals').get()).toEqual({ count: 1 })
      expect(database.query('SELECT content FROM modules WHERE id = ?').get(draftId)).toEqual(draftRow)
      expect(database.query('SELECT content FROM modules WHERE id = ?').get(acceptedId)).toEqual(acceptedRow)

      expect((await tutor(learner, courseId, { moduleId: acceptedId, lessonIndex: 0, message: 'Stale?', proposal: true, expectedDraftContentHash: 'stale' })).response.status).toBe(409)
      expect(database.query('SELECT COUNT(*) AS count FROM tutor_proposals').get()).toEqual({ count: 1 })

      // The draft changes while the model runs: the post-model transaction must not store the proposal.
      const during = modelCapture('LATE PROPOSAL', () => { database.run('UPDATE modules SET content = ? WHERE id = ?', [JSON.stringify({ ...draft, title: 'Draft changed during generation' }), draftId]) })
      try {
        const late = await tutor(learner, courseId, { moduleId: acceptedId, lessonIndex: 0, attemptIds: [attempt], message: 'Another improvement.', proposal: true, expectedDraftContentHash: draftHash })
        expect(late.response.status).toBe(409)
      } finally { during.restore() }
      expect(database.query('SELECT COUNT(*) AS count FROM tutor_proposals').get()).toEqual({ count: 1 })
      expect(database.query('SELECT COUNT(*) AS count FROM tutor_turns').get()).toEqual({ count: 2 })

      database.run('UPDATE modules SET content = ? WHERE id = ?', [JSON.stringify({ ...draft, title: 'Draft module' }), draftId])
      database.run('UPDATE modules SET accepted = 1, accepted_at = ? WHERE id = ?', [clock, draftId])
      const noDraft = modelCapture('PROPOSAL: for future material only.')
      try {
        const result = await tutor(learner, courseId, { moduleId: acceptedId, lessonIndex: 0, message: 'No draft now.', proposal: true })
        expect(result.response.status).toBe(200)
        expect(result.body.proposal?.draft).toBeNull()
      } finally { noDraft.restore() }
      const stored = await history(learner, courseId, acceptedId, 0)
      expect(stored.body.proposals).toHaveLength(2)
    } finally { database.close() }
  })

  test('rejects a turn when the lesson conversation changes while the model is running', async () => {
    clock = 1_700_900_000_000
    const { database, learner } = setup()
    try {
      const courseId = await createCourse(learner)
      const content = moduleContent('Accepted module', 'accepted')
      const moduleId = insertModule(database, courseId, 1, 1, content)
      const attempt = insertAttempt(database, moduleId, content.exercises[0]!.id, 0, 'A', 'Feedback.', 1)
      const first = modelCapture('First answer.')
      try { expect((await tutor(learner, courseId, { moduleId, lessonIndex: 0, attemptIds: [attempt], message: 'First.' })).response.status).toBe(200) } finally { first.restore() }
      const concurrent = modelCapture('Should not be stored.', () => {
        const context = JSON.stringify({ concurrent: true })
        database.run('INSERT INTO tutor_turns (id, course_id, module_id, lesson_index, role, content, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), courseId, moduleId, 0, 'user', 'Concurrent question.', context, clock])
        database.run('INSERT INTO tutor_turns (id, course_id, module_id, lesson_index, role, content, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), courseId, moduleId, 0, 'assistant', 'Concurrent answer.', context, clock])
      })
      try {
        const response = await tutor(learner, courseId, { moduleId, lessonIndex: 0, attemptIds: [attempt], message: 'Racy question.' })
        expect(response.response.status).toBe(409)
        expect((response.body as unknown as { error: string }).error).toContain('conversation changed')
      } finally { concurrent.restore() }
      const turns = database.query('SELECT content FROM tutor_turns WHERE module_id = ? ORDER BY rowid').all(moduleId) as { content: string }[]
      expect(turns.map((turn) => turn.content)).toEqual(['First.', 'First answer.', 'Concurrent question.', 'Concurrent answer.'])
    } finally { database.close() }
  })

  test('rejects an over-budget context without contacting the provider', async () => {
    clock = 1_701_000_000_000
    const { database, learner } = setup()
    try {
      const courseId = await createCourse(learner)
      const content = moduleContent('Large module', 'large')
      const moduleId = insertModule(database, courseId, 1, 1, content)
      const attempts = Array.from({ length: 20 }, () => insertAttempt(database, moduleId, content.exercises[0]!.id, 0, 'A', 'x'.repeat(6000), 1))
      const model = modelCapture('Should not be called.')
      try {
        const response = await call(learner, `/api/courses/${courseId}/tutor`, { moduleId, lessonIndex: 0, attemptIds: attempts, message: 'Too much?' })
        expect(response.status).toBe(400)
        expect(((await response.json()) as { error: string }).error).toContain('120,000')
        expect(model.requests).toHaveLength(0)
      } finally { model.restore() }
      expect(database.query('SELECT COUNT(*) AS count FROM tutor_turns').get()).toEqual({ count: 0 })
    } finally { database.close() }
  })
})
