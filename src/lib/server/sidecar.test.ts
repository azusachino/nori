import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelError } from './ai'
import { openDatabase } from './database'
import { createSidecarApi, hashExerciseSnapshot, type ExerciseSnapshot, type PracticeAttempt } from './sidecar'

const dirs: string[] = []

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'nori-sidecar-'))
  dirs.push(dir)
  return join(dir, 'nori.sqlite')
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const mcqSnapshot: ExerciseSnapshot = {
  type: 'multiple_choice',
  prompt: 'Which distribution belongs to the exponential family?',
  options: [' Gaussian ', 'Cauchy'],
  answer: ' Gaussian ',
  explanation: 'Gaussian has finite sufficient statistics; Cauchy does not.',
}

const writtenSnapshot: ExerciseSnapshot = {
  type: 'written',
  prompt: 'State why the canonical link simplifies GLM gradients.',
  options: [],
  answer: 'Setting eta = theta^T x makes the gradient (y - E[y]) x.',
  explanation: 'The log-partition derivative matches the mean.',
}

describe('sidecar v1 API (Slice 1)', () => {
  test('health reports apiVersion, llmConfigured, and honors custom basePath', async () => {
    const db = openDatabase(tempDbPath())
    const prevBase = process.env.NORI_LLM_BASE_URL
    const prevModel = process.env.NORI_LLM_MODEL
    try {
      delete process.env.NORI_LLM_BASE_URL
      delete process.env.NORI_LLM_MODEL
      const defaultApi = createSidecarApi(db)
      const res1 = await defaultApi(new Request('http://127.0.0.1:3001/api/nori/v1/health'))
      expect(res1.status).toBe(200)
      expect(await res1.json()).toEqual({ ok: true, apiVersion: 1, llmConfigured: false, features: ['tutor-stream', 'progress', 'assessment-sample'] })
      expect((await defaultApi(new Request('http://127.0.0.1:3001/v1/health'))).status).toBe(404)

      process.env.NORI_LLM_BASE_URL = 'http://127.0.0.1:11434/v1'
      process.env.NORI_LLM_MODEL = 'qwen3'
      const strippedApi = createSidecarApi(db, { basePath: '' })
      const res2 = await strippedApi(new Request('http://127.0.0.1:3001/v1/health'))
      expect(res2.status).toBe(200)
      expect(await res2.json()).toEqual({ ok: true, apiVersion: 1, llmConfigured: true, features: ['tutor-stream', 'progress', 'assessment-sample'] })
    } finally {
      if (prevBase === undefined) delete process.env.NORI_LLM_BASE_URL
      else process.env.NORI_LLM_BASE_URL = prevBase
      if (prevModel === undefined) delete process.env.NORI_LLM_MODEL
      else process.env.NORI_LLM_MODEL = prevModel
      db.close()
    }
  })

  test('validates canonical external keys and contentHash', async () => {
    const db = openDatabase(tempDbPath())
    try {
      const api = createSidecarApi(db)
      const post = (body: unknown) =>
        api(
          new Request('http://127.0.0.1:3001/api/nori/v1/practice/attempts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        )

      expect((await post({ courseKey: 'courses/ai/cs229', exerciseKey: 'ex-1', exerciseSnapshot: writtenSnapshot, answer: 'hi' })).status).toBe(400)
      expect((await post({ courseKey: 'ai/cs229', lessonKey: '01-intro.md', exerciseKey: 'ex-1', exerciseSnapshot: writtenSnapshot, answer: 'hi' })).status).toBe(400)
      expect((await post({ courseKey: 'ai/cs229', lessonKey: '../escape', exerciseKey: 'ex-1', exerciseSnapshot: writtenSnapshot, answer: 'hi' })).status).toBe(400)
      expect(
        (
          await post({
            courseKey: 'ai/cs229',
            lessonKey: '01-intro',
            exerciseKey: 'ex-1',
            contentHash: 'deadbeef',
            exerciseSnapshot: writtenSnapshot,
            answer: 'hi',
          })
        ).status,
      ).toBe(400)
      expect((await api(new Request('http://127.0.0.1:3001/api/nori/v1/practice?courseKey=courses/ai/cs229'))).status).toBe(400)
    } finally {
      db.close()
    }
  })

  test('scores MCQ deterministically (preserving option whitespace) and rejects LLM feedback on MCQ', async () => {
    const db = openDatabase(tempDbPath())
    try {
      let clock = 1000
      const api = createSidecarApi(db, { now: () => ++clock })

      const resCorrect = await api(
        new Request('http://127.0.0.1:3001/api/nori/v1/practice/attempts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey: 'ai/stanford-cs229-ml',
            lessonKey: '01-exponential-families-and-glms',
            exerciseKey: 'mcq-1',
            contentHash: hashExerciseSnapshot(mcqSnapshot),
            exerciseSnapshot: mcqSnapshot,
            answer: ' Gaussian ',
          }),
        }),
      )
      expect(resCorrect.status).toBe(201)
      const { attempt } = (await resCorrect.json()) as { attempt: PracticeAttempt }
      expect(attempt.grading).toBe('deterministic')
      expect(attempt.correct).toBe(1)
      expect(attempt.advisory).toBe(false)
      expect(attempt.version).toBe(0)

      const resWrong = await api(
        new Request('http://127.0.0.1:3001/api/nori/v1/practice/attempts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey: 'ai/stanford-cs229-ml',
            lessonKey: '01-exponential-families-and-glms',
            exerciseKey: 'mcq-1',
            exerciseSnapshot: mcqSnapshot,
            answer: 'Cauchy',
          }),
        }),
      )
      expect(resWrong.status).toBe(201)
      const wrongData = (await resWrong.json()) as { attempt: PracticeAttempt }
      expect(wrongData.attempt.correct).toBe(0)

      const fbRes = await api(
        new Request(`http://127.0.0.1:3001/api/nori/v1/practice/attempts/${attempt.id}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(fbRes.status).toBe(409)
    } finally {
      db.close()
    }
  })

  test('persists written attempts across reopen, handles advisory feedback, 502 failure, and version conflicts', async () => {
    const dbPath = tempDbPath()
    let db = openDatabase(dbPath)
    let capturedMessages: { role: string; content: string }[] = []
    let failModel = false
    let onBeforeModelReturn: (() => Promise<void>) | null = null
    let clock = 5000

    const makeApi = (database: typeof db) =>
      createSidecarApi(database, {
        now: () => ++clock,
        completeFn: async (messages) => {
          capturedMessages = messages
          if (onBeforeModelReturn) {
            const hook = onBeforeModelReturn
            onBeforeModelReturn = null
            await hook()
          }
          if (failModel) throw new ModelError('Upstream 503')
          return 'Advisory: clear connection to canonical link; mention log-partition derivative.'
        },
      })

    try {
      const api = makeApi(db)
      const createRes = await api(
        new Request('http://127.0.0.1:3001/api/nori/v1/practice/attempts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey: 'ai/stanford-cs229-ml',
            lessonKey: '01-exponential-families-and-glms',
            exerciseKey: 'written-1',
            exerciseSnapshot: writtenSnapshot,
            answer: '  eta = theta^T x simplifies the derivative  ',
          }),
        }),
      )
      expect(createRes.status).toBe(201)
      const created = ((await createRes.json()) as { attempt: PracticeAttempt }).attempt
      expect(created.grading).toBe('unscored')
      expect(created.correct).toBeNull()
      expect(created.answer).toBe('eta = theta^T x simplifies the derivative')

      // Provider error returns 502 and leaves attempt untouched
      failModel = true
      const failRes = await api(
        new Request(`http://127.0.0.1:3001/api/nori/v1/practice/attempts/${created.id}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedVersion: 0 }),
        }),
      )
      expect(failRes.status).toBe(502)
      failModel = false

      // Concurrent correction while model is running triggers 409 without overwriting
      onBeforeModelReturn = async () => {
        const corr = await api(
          new Request(`http://127.0.0.1:3001/api/nori/v1/practice/attempts/${created.id}/correct`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ownerNote: 'Self-check before AI reply', expectedVersion: 0 }),
          }),
        )
        expect(corr.status).toBe(200)
      }
      const conflictRes = await api(
        new Request(`http://127.0.0.1:3001/api/nori/v1/practice/attempts/${created.id}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedVersion: 0 }),
        }),
      )
      expect(conflictRes.status).toBe(409)
      const conflictBody = (await conflictRes.json()) as { attempt: PracticeAttempt }
      expect(conflictBody.attempt.version).toBe(1)
      expect(conflictBody.attempt.ownerNote).toBe('Self-check before AI reply')
      expect(conflictBody.attempt.advisory).toBe(false)

      // Request feedback with current version 1 -> succeeds
      const okFeedback = await api(
        new Request(`http://127.0.0.1:3001/api/nori/v1/practice/attempts/${created.id}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedVersion: 1 }),
        }),
      )
      expect(okFeedback.status).toBe(200)
      const withFeedback = ((await okFeedback.json()) as { attempt: PracticeAttempt }).attempt
      expect(withFeedback.advisory).toBe(true)
      expect(withFeedback.version).toBe(2)
      expect(withFeedback.feedback).toContain('Advisory:')
      expect(capturedMessages[0]?.content).toContain('untrusted study data')

      // Stale correction rejected
      const staleCorr = await api(
        new Request(`http://127.0.0.1:3001/api/nori/v1/practice/attempts/${created.id}/correct`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ownerNote: 'Stale note', expectedVersion: 1 }),
        }),
      )
      expect(staleCorr.status).toBe(409)

      // Reopen database and verify persistence + list filtering
      db.close()
      db = openDatabase(dbPath)
      const reopenedApi = makeApi(db)
      const listRes = await reopenedApi(
        new Request('http://127.0.0.1:3001/api/nori/v1/practice?courseKey=ai/stanford-cs229-ml&lessonKey=01-exponential-families-and-glms&exerciseKey=written-1'),
      )
      expect(listRes.status).toBe(200)
      const listed = (await listRes.json()) as { attempts: PracticeAttempt[] }
      expect(listed.attempts).toHaveLength(1)
      expect(listed.attempts[0]?.id).toBe(created.id)
      expect(listed.attempts[0]?.feedback).toContain('Advisory:')
      expect(listed.attempts[0]?.ownerNote).toBe('Self-check before AI reply')
    } finally {
      db.close()
    }
  })
})
