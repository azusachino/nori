import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/server/database'
import { createSidecarApi, hashExerciseSnapshot } from '../lib/server/sidecar'
import {
  checkMultipleChoice,
  computeContentHash,
  formatAttemptsAsMarkdown,
  NoriApiError,
  NoriClient,
  type ExerciseSnapshot,
} from './index'

const dirs: string[] = []

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'nori-sdk-'))
  dirs.push(dir)
  return join(dir, 'nori.sqlite')
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const snapshot: ExerciseSnapshot = {
  type: 'written',
  prompt: 'Identify b(y), eta, and a(eta) for the Poisson distribution.',
  options: [],
  answer: 'b(y)=1/y!, eta=log(lambda), a(eta)=exp(eta).',
  explanation: 'a\'(eta)=exp(eta)=lambda.',
}

describe('Nori SDK client and helpers', () => {
  test('computeContentHash matches server hashExerciseSnapshot', async () => {
    expect(await computeContentHash(snapshot)).toBe(hashExerciseSnapshot(snapshot))
  })

  test('checkMultipleChoice matches exact option text', () => {
    const mcq: ExerciseSnapshot = {
      type: 'multiple_choice',
      prompt: 'Pick one',
      options: ['A', 'B'],
      answer: 'A',
      explanation: 'A is right.',
    }
    expect(checkMultipleChoice(mcq, 'A')).toBe(true)
    expect(checkMultipleChoice(mcq, 'B')).toBe(false)
    expect(checkMultipleChoice(mcq, 'C')).toBe(false)
  })

  test('NoriClient roundtrips against sidecar API and surfaces 409 conflicts', async () => {
    const db = openDatabase(tempDbPath())
    try {
      const api = createSidecarApi(db, {
        completeFn: async () => 'Advisory: good identification of natural parameter.',
      })
      const client = new NoriClient({
        baseUrl: 'http://127.0.0.1:3001/api/nori/v1',
        fetchFn: (input, init) => api(new Request(input instanceof Request ? input : String(input), init)),
      })

      const health = await client.health()
      expect(health.ok).toBe(true)
      expect(health.apiVersion).toBe(1)

      const contentHash = await computeContentHash(snapshot)
      const created = await client.createAttempt({
        courseKey: 'ai/stanford-cs229-ml',
        lessonKey: '01-exponential-families-and-glms',
        exerciseKey: 'ex-poisson',
        contentHash,
        exerciseSnapshot: snapshot,
        answer: 'b(y) = 1/y!, eta = log(lambda), a(eta) = e^eta',
      })
      expect(created.version).toBe(0)

      const withFeedback = await client.requestFeedback(created.id, 0)
      expect(withFeedback.advisory).toBe(true)
      expect(withFeedback.version).toBe(1)

      const corrected = await client.saveCorrection(created.id, 'Remember to check a\'(eta)=lambda.', 1)
      expect(corrected.version).toBe(2)
      expect(corrected.ownerNote).toBe("Remember to check a'(eta)=lambda.")

      let caught: unknown = null
      try {
        await client.saveCorrection(created.id, 'stale', 0)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(NoriApiError)
      expect((caught as NoriApiError).status).toBe(409)
      expect((caught as NoriApiError).attempt?.version).toBe(2)

      const listed = await client.listPractice({
        courseKey: 'ai/stanford-cs229-ml',
        lessonKey: '01-exponential-families-and-glms',
      })
      expect(listed.attempts).toHaveLength(1)

      const md = formatAttemptsAsMarkdown({
        courseKey: 'ai/stanford-cs229-ml',
        lessonKey: '01-exponential-families-and-glms',
        attempts: listed.attempts,
      })
      expect(md).toContain('## practice attempts: ai/stanford-cs229-ml — 01-exponential-families-and-glms')
      expect(md).toContain('**Advisory feedback (AI):**')
      expect(md).toContain('**Correction / takeaway:**')
    } finally {
      db.close()
    }
  })
})
