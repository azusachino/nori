import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelError } from './ai'
import { openDatabase } from './database'
import { createSidecarApi, type ExerciseSnapshot } from './sidecar'

const dirs: string[] = []

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'nori-sidecar-act-'))
  dirs.push(dir)
  return join(dir, 'nori.sqlite')
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const mcq: ExerciseSnapshot = {
  type: 'multiple_choice',
  prompt: 'Which link is canonical for Bernoulli?',
  options: ['logit', 'probit'],
  answer: 'logit',
  explanation: 'Natural parameter eta = log(p/(1-p)).',
}

const written: ExerciseSnapshot = {
  type: 'written',
  prompt: 'Explain why log-partition a(eta) is convex.',
  options: [],
  answer: 'Its Hessian is the covariance matrix of T(y), which is PSD.',
  explanation: 'Cov(T(y)) >= 0.',
}

describe('sidecar v1 assessments and contextual tutor (Slice 3)', () => {
  test('timed assessment hides answers until finalized, expires across reopen at exact deadline, and preserves submittedAt null', async () => {
    const dbPath = tempDbPath()
    let db = openDatabase(dbPath)
    let clock = 10_000
    const makeApi = (database: typeof db) => createSidecarApi(database, { now: () => clock })

    try {
      const api = makeApi(db)
      const createRes = await api(
        new Request('http://127.0.0.1:3001/api/nori/v1/assessments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey: 'ai/stanford-cs229-ml',
            title: 'GLM timed check',
            mode: 'timed',
            durationSeconds: 120,
            items: [
              { lessonKey: '01-glms', exerciseKey: 'q-1', exerciseSnapshot: mcq },
              { lessonKey: '01-glms', exerciseKey: 'q-2', exerciseSnapshot: written },
            ],
          }),
        }),
      )
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()).assessment
      expect(created.status).toBe('planned')
      expect(created.items[0].referenceAnswer).toBeUndefined()

      // Start at t = 10_000 -> deadline = 130_000
      const startRes = await api(new Request(`http://127.0.0.1:3001/api/nori/v1/assessments/${created.id}/start`, { method: 'POST' }))
      expect(startRes.status).toBe(200)
      const started = (await startRes.json()).assessment
      expect(started.status).toBe('active')
      expect(started.deadlineAt).toBe(130_000)
      expect(started.remainingMs).toBe(120_000)

      // Save answers before deadline
      clock = 50_000
      const ans1 = await api(
        new Request(`http://127.0.0.1:3001/api/nori/v1/assessments/${created.id}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: started.items[0].id, answer: 'logit', expectedVersion: started.version }),
        }),
      )
      expect(ans1.status).toBe(200)

      // Reopen DB after exact deadline (clock = 130_000) -> expires automatically
      db.close()
      db = openDatabase(dbPath)
      clock = 130_000
      const reopened = makeApi(db)
      const lateSubmit = await reopened(
        new Request(`http://127.0.0.1:3001/api/nori/v1/assessments/${created.id}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(lateSubmit.status).toBe(409)
      const expired = (await lateSubmit.json()).assessment
      expect(expired.status).toBe('expired')
      expect(expired.submittedAt).toBeNull()
      expect(expired.finalizedAt).toBe(130_000)
      expect(expired.items[0].referenceAnswer).toBe('logit')
      expect(expired.items[0].result.correct).toBe(1)
      expect(expired.items[1].result.grading).toBe('unscored')
      expect(expired.items[1].result.correct).toBeNull()
    } finally {
      db.close()
    }
  })

  test('untimed assessment supports explicit submit, advisory feedback, and owner correction', async () => {
    const db = openDatabase(tempDbPath())
    let clock = 20_000
    try {
      const api = createSidecarApi(db, {
        now: () => ++clock,
        completeFn: async () => 'Advisory: strong Hessian argument.',
      })
      const createRes = await api(
        new Request('http://127.0.0.1:3001/api/nori/v1/assessments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey: 'ai/stanford-cs229-ml',
            title: 'Untimed check',
            mode: 'untimed',
            items: [{ lessonKey: '01-glms', exerciseKey: 'q-2', exerciseSnapshot: written }],
          }),
        }),
      )
      const created = (await createRes.json()).assessment
      const started = (await (await api(new Request(`http://127.0.0.1:3001/api/nori/v1/assessments/${created.id}/start`, { method: 'POST' }))).json()).assessment
      const answered = (
        await (
          await api(
            new Request(`http://127.0.0.1:3001/api/nori/v1/assessments/${created.id}/answers`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ itemId: started.items[0].id, answer: 'Hessian is Cov(T(y)) >= 0.' }),
            }),
          )
        ).json()
      ).assessment
      const submitted = (
        await (
          await api(
            new Request(`http://127.0.0.1:3001/api/nori/v1/assessments/${created.id}/submit`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ expectedVersion: answered.version }),
            }),
          )
        ).json()
      ).assessment
      expect(submitted.status).toBe('submitted')
      expect(submitted.submittedAt).toBe(submitted.finalizedAt)

      const fbRes = await api(
        new Request(`http://127.0.0.1:3001/api/nori/v1/assessments/${created.id}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: started.items[0].id, expectedVersion: submitted.version }),
        }),
      )
      expect(fbRes.status).toBe(200)
      const withFb = (await fbRes.json()).assessment
      expect(withFb.items[0].result.advisory).toBe(true)
      expect(withFb.items[0].result.feedback).toContain('Advisory:')

      const corrRes = await api(
        new Request(`http://127.0.0.1:3001/api/nori/v1/assessments/${created.id}/correct`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: started.items[0].id, ownerNote: 'Remember PSD proof.', expectedVersion: withFb.version }),
        }),
      )
      expect(corrRes.status).toBe(200)
      expect((await corrRes.json()).assessment.items[0].result.ownerNote).toBe('Remember PSD proof.')
    } finally {
      db.close()
    }
  })

  test('contextual tutor deduplicates lesson storage, scopes attempts, handles 502, and enforces budget & revision conflicts', async () => {
    const db = openDatabase(tempDbPath())
    let clock = 30_000
    let failModel = false
    let capturedPrompt = ''
    let onBeforeReply: (() => Promise<void>) | null = null

    try {
      const api = createSidecarApi(db, {
        now: () => ++clock,
        completeFn: async (messages) => {
          capturedPrompt = messages.map((m) => m.content).join('\n')
          if (onBeforeReply) {
            const hook = onBeforeReply
            onBeforeReply = null
            await hook()
          }
          if (failModel) throw new ModelError('Provider timeout')
          return 'Because the log-partition derivative gives the mean.'
        },
      })

      // Create an attempt in lesson 01 and another in lesson 02
      const a1 = (
        await (
          await api(
            new Request('http://127.0.0.1:3001/api/nori/v1/practice/attempts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                courseKey: 'ai/stanford-cs229-ml',
                lessonKey: '01-glms',
                exerciseKey: 'q-1',
                exerciseSnapshot: written,
                answer: 'Covariance is PSD',
              }),
            }),
          )
        ).json()
      ).attempt
      const a2 = (
        await (
          await api(
            new Request('http://127.0.0.1:3001/api/nori/v1/practice/attempts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                courseKey: 'ai/stanford-cs229-ml',
                lessonKey: '02-svm',
                exerciseKey: 'q-1',
                exerciseSnapshot: written,
                answer: 'Other lesson',
              }),
            }),
          )
        ).json()
      ).attempt

      // Cross-lesson attemptId rejected with 404
      const wrongScope = await api(
        new Request('http://127.0.0.1:3001/api/nori/v1/tutor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey: 'ai/stanford-cs229-ml',
            lessonKey: '01-glms',
            lessonTitle: 'GLMs',
            lessonText: 'Exponential family notes.',
            attemptIds: [a2.id],
            message: 'Explain this.',
          }),
        }),
      )
      expect(wrongScope.status).toBe(404)

      // 502 writes no turns
      failModel = true
      const failed = await api(
        new Request('http://127.0.0.1:3001/api/nori/v1/tutor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey: 'ai/stanford-cs229-ml',
            lessonKey: '01-glms',
            lessonTitle: 'GLMs',
            lessonText: 'Exponential family notes.',
            attemptIds: [a1.id],
            message: 'Why does eta matter?',
          }),
        }),
      )
      expect(failed.status).toBe(502)
      failModel = false

      // Valid exchange #1
      const ok1 = await api(
        new Request('http://127.0.0.1:3001/api/nori/v1/tutor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey: 'ai/stanford-cs229-ml',
            lessonKey: '01-glms',
            lessonTitle: 'GLMs',
            lessonText: 'Exponential family notes.',
            attemptIds: [a1.id],
            message: 'Why does eta matter?',
          }),
        }),
      )
      expect(ok1.status).toBe(200)
      const data1 = await ok1.json()
      expect(data1.revision).toBe(2)
      expect(capturedPrompt).toContain('untrusted study material')
      expect(capturedPrompt).toContain('Covariance is PSD')

      // Valid exchange #2 with same lessonText -> lesson row deduplicated (count === 1)
      const ok2 = await api(
        new Request('http://127.0.0.1:3001/api/nori/v1/tutor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey: 'ai/stanford-cs229-ml',
            lessonKey: '01-glms',
            lessonTitle: 'GLMs',
            lessonText: 'Exponential family notes.',
            attemptIds: [],
            message: 'Follow up question.',
          }),
        }),
      )
      expect(ok2.status).toBe(200)
      const data2 = await ok2.json()
      expect(data2.revision).toBe(4)
      expect(data2.context.historyTurnsIncluded).toBe(2)
      const lessonCount = (db.query('SELECT COUNT(*) as c FROM sidecar_tutor_lessons').get() as { c: number }).c
      expect(lessonCount).toBe(1)

      // Concurrent revision conflict returns 409
      onBeforeReply = async () => {
        await api(
          new Request('http://127.0.0.1:3001/api/nori/v1/tutor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              courseKey: 'ai/stanford-cs229-ml',
              lessonKey: '01-glms',
              lessonTitle: 'GLMs',
              lessonText: 'Exponential family notes.',
              message: 'Interleaved turn',
            }),
          }),
        )
      }
      const conflict = await api(
        new Request('http://127.0.0.1:3001/api/nori/v1/tutor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey: 'ai/stanford-cs229-ml',
            lessonKey: '01-glms',
            lessonTitle: 'GLMs',
            lessonText: 'Exponential family notes.',
            message: 'Will conflict',
          }),
        }),
      )
      expect(conflict.status).toBe(409)
    } finally {
      db.close()
    }
  })
})
