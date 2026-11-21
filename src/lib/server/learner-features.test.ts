import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { openDatabase } from './database'
import { buildReviewQueue } from './review'
import { sampleWeighted, seededRandom } from './sampling'
import { sidecarSchema } from './schema'
import { createSidecarApi, type ExerciseSnapshot } from './sidecar'

const BASE = 'http://127.0.0.1:3001/api/nori/v1'
const COURSE = 'ai/cs229'
const DAY = 86_400_000
const dirs: string[] = []
const dbs: { close(): void }[] = []

afterEach(() => {
  while (dbs.length) dbs.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function setup(start = 1_000_000) {
  const dir = mkdtempSync(join(tmpdir(), 'nori-learner-features-'))
  dirs.push(dir)
  const db = openDatabase(join(dir, 'nori.sqlite'))
  dbs.push(db)
  const clock = { now: start }
  const api = createSidecarApi(db, { now: () => clock.now })
  return { db, api, clock }
}

const mcq: ExerciseSnapshot = { type: 'multiple_choice', prompt: 'Pick', options: ['A', 'B'], answer: 'A', explanation: '' }
const written: ExerciseSnapshot = { type: 'written', prompt: 'Explain', options: [], answer: 'Because.', explanation: '' }

function json(method: string, path: string, body?: unknown) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function attempt(api: ReturnType<typeof setup>['api'], lessonKey: string, exerciseKey: string, snapshot: ExerciseSnapshot, answer: string) {
  const res = await api(json('POST', '/practice/attempts', { courseKey: COURSE, lessonKey, exerciseKey, exerciseSnapshot: snapshot, answer }))
  expect(res.status).toBe(201)
}

const pool = (n: number, lessonKey = '01-glms') =>
  Array.from({ length: n }, (_, i) => ({ lessonKey, exerciseKey: `q-${i}`, exerciseSnapshot: { ...mcq, prompt: `Pick ${i}` } }))

describe('GET /v1/progress', () => {
  test('counts per lesson: attempted, correct, incorrect, due, attempts and last activity', async () => {
    const { api, clock } = setup()
    await attempt(api, '01-glms', 'q-1', mcq, 'A') // correct, due in 1 day
    clock.now += 10
    await attempt(api, '01-glms', 'q-2', mcq, 'B') // incorrect, due now
    clock.now += 10
    await attempt(api, '01-glms', 'q-2', mcq, 'B')
    clock.now += 10
    await attempt(api, '02-svm', 'w-1', written, 'An answer') // open-ended, due in 3 days
    const lastAt = clock.now

    const res = await api(json('GET', `/progress?courseKey=${COURSE}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lessons).toEqual([
      { lessonKey: '01-glms', exercisesAttempted: 2, exercisesCorrect: 1, exercisesIncorrect: 1, exercisesDue: 1, attempts: 3, lastActivityAt: lastAt - 10 },
      { lessonKey: '02-svm', exercisesAttempted: 1, exercisesCorrect: 0, exercisesIncorrect: 0, exercisesDue: 0, attempts: 1, lastActivityAt: lastAt },
    ])
    expect(body.totals).toEqual({ exercisesAttempted: 3, exercisesCorrect: 1, exercisesIncorrect: 1, exercisesDue: 1, attempts: 4, lastActivityAt: lastAt })

    // Two days on, the correct one is due as well; the open-ended one is not yet.
    clock.now += 2 * DAY
    const later = await (await api(json('GET', `/progress?courseKey=${COURSE}`))).json()
    expect(later.lessons.map((l: { exercisesDue: number }) => l.exercisesDue)).toEqual([2, 0])
  })

  test('agrees with the review queue on random history', async () => {
    const { db, api, clock } = setup()
    const random = seededRandom(7)
    const lessons = ['01-a', '02-b', '03-c']
    for (let i = 0; i < 300; i++) {
      clock.now += Math.floor(random() * DAY)
      const lessonKey = lessons[Math.floor(random() * lessons.length)]!
      const exerciseKey = `q-${Math.floor(random() * 12)}`
      if (random() < 0.2) await attempt(api, lessonKey, exerciseKey, written, 'text')
      else await attempt(api, lessonKey, exerciseKey, mcq, random() < 0.6 ? 'A' : 'B')
    }
    clock.now += 2 * DAY
    const progress = await (await api(json('GET', `/progress?courseKey=${COURSE}`))).json()

    // Reference: group the review queue's per-exercise rows by lesson in JavaScript.
    const queue = buildReviewQueue(drizzle(db, { schema: sidecarSchema }), { courseKey: COURSE, now: clock.now })
    const expected = lessons
      .map((lessonKey) => {
        const items = queue.items.filter((i) => i.lessonKey === lessonKey)
        return {
          lessonKey,
          exercisesAttempted: items.length,
          exercisesCorrect: items.filter((i) => i.latestAttempt.grading === 'deterministic' && i.latestAttempt.correct === 1).length,
          exercisesIncorrect: items.filter((i) => i.latestAttempt.grading === 'deterministic' && i.latestAttempt.correct === 0).length,
          exercisesDue: items.filter((i) => i.isDue).length,
          attempts: items.reduce((n, i) => n + i.attemptCount, 0),
          lastActivityAt: Math.max(...items.map((i) => i.lastAttemptAt)),
        }
      })
      .filter((l) => l.exercisesAttempted > 0)
    expect(progress.lessons).toEqual(expected)
    expect(progress.totals.exercisesDue).toBe(queue.summary.dueNow)
  })

  test('rejects a bad course key and lists nothing for an unpractised course', async () => {
    const { api } = setup()
    expect((await api(json('GET', '/progress?courseKey=bad'))).status).toBe(400)
    const empty = await (await api(json('GET', `/progress?courseKey=${COURSE}`))).json()
    expect(empty.lessons).toEqual([])
    expect(empty.totals.attempts).toBe(0)
  })
})

describe('assessment sampling', () => {
  const create = (api: ReturnType<typeof setup>['api'], items: unknown[], sample?: unknown) =>
    api(json('POST', '/assessments', { courseKey: COURSE, title: 'Quiz', mode: 'untimed', items, ...(sample ? { sample } : {}) }))

  const drawnKeys = (body: { assessment: { items: { exerciseKey: string }[] } }) => body.assessment.items.map((i) => i.exerciseKey)

  test('draws count items reproducibly by seed', async () => {
    const { api } = setup()
    const first = await (await create(api, pool(40), { count: 8, seed: 12345 })).json()
    expect(first.sample).toEqual({ strategy: 'random', seed: 12345, count: 8, poolSize: 40 })
    expect(first.assessment.items.length).toBe(8)
    expect(first.assessment.items.map((i: { position: number }) => i.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(new Set(drawnKeys(first)).size).toBe(8)

    const again = await (await create(api, pool(40), { count: 8, seed: 12345 })).json()
    expect(drawnKeys(again)).toEqual(drawnKeys(first))
    const other = await (await create(api, pool(40), { count: 8, seed: 54321 })).json()
    expect(drawnKeys(other)).not.toEqual(drawnKeys(first))

    // Without a seed the sidecar picks one and returns it, so the draw can be repeated.
    const unseeded = await (await create(api, pool(40), { count: 5 })).json()
    const repeat = await (await create(api, pool(40), { count: 5, seed: unseeded.sample.seed })).json()
    expect(drawnKeys(repeat)).toEqual(drawnKeys(unseeded))
  })

  test('a count above the pool size takes the whole pool', async () => {
    const { api } = setup()
    const body = await (await create(api, pool(3), { count: 10, seed: 1 })).json()
    expect(body.sample).toMatchObject({ count: 3, poolSize: 3 })
  })

  test('validates the sample and the pool', async () => {
    const { api } = setup()
    expect((await create(api, pool(101))).status).toBe(400)
    expect((await create(api, pool(500), { count: 100, seed: 1 })).status).toBe(201)
    expect((await create(api, pool(501), { count: 10 })).status).toBe(400)
    expect((await create(api, pool(10), { count: 0 })).status).toBe(400)
    expect((await create(api, pool(10), { count: 101 })).status).toBe(400)
    expect((await create(api, pool(10), { count: 2, strategy: 'hardest' })).status).toBe(400)
    expect((await create(api, pool(10), { count: 2, seed: -1 })).status).toBe(400)
    expect((await create(api, pool(10), { count: 2, seed: 2 ** 32 })).status).toBe(400)
    const dup = await create(api, [...pool(3), pool(3)[0]], { count: 2 })
    expect(dup.status).toBe(400)
    expect((await dup.json()).error).toContain('twice')
    // Without sample, the response shape is unchanged.
    expect(Object.keys(await (await create(api, pool(3))).json())).toEqual(['assessment'])
  })

  test('identifies pool items by lesson and exercise key', async () => {
    const { api } = setup()
    // Two lessons that both use q-0..q-2 sample together.
    const res = await create(api, [...pool(3, '01-glms'), ...pool(3, '02-svms')], { count: 6, seed: 7 })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.sample.poolSize).toBe(6)
    const drawn = body.assessment.items.map((i: { lessonKey: string; exerciseKey: string }) => `${i.lessonKey}/${i.exerciseKey}`)
    expect(new Set(drawn).size).toBe(6)
    // The same lesson and key twice is still a duplicate.
    const dup = await create(api, [...pool(3, '01-glms'), ...pool(3, '02-svms'), pool(3, '02-svms')[1]], { count: 2 })
    expect(dup.status).toBe(400)
    expect((await dup.json()).error).toContain('twice')
  })

  test('the weak strategy favours incorrect and due exercises over well-known ones', async () => {
    const { api } = setup()
    const items = pool(10)
    // q-0 incorrect (weight 4), q-1 correct and not due (1), q-2..q-9 never practised (2).
    await attempt(api, '01-glms', 'q-0', items[0]!.exerciseSnapshot, 'B')
    await attempt(api, '01-glms', 'q-1', items[1]!.exerciseSnapshot, 'A')
    const tally: Record<string, number> = {}
    const randomTally: Record<string, number> = {}
    for (let seed = 0; seed < 400; seed++) {
      const weak = await (await create(api, items, { count: 1, strategy: 'weak', seed })).json()
      tally[drawnKeys(weak)[0]!] = (tally[drawnKeys(weak)[0]!] ?? 0) + 1
      const random = await (await create(api, items, { count: 1, seed })).json()
      randomTally[drawnKeys(random)[0]!] = (randomTally[drawnKeys(random)[0]!] ?? 0) + 1
    }
    // Expected shares: q-0 4/21 (76 of 400), q-1 1/21 (19); uniform 40 each.
    expect(tally['q-0']!).toBeGreaterThan(55)
    expect(tally['q-1'] ?? 0).toBeLessThan(35)
    expect(randomTally['q-0']!).toBeLessThan(60)
  })
})

describe('sampleWeighted', () => {
  test('equal weights draw every item about equally often', () => {
    const counts = new Array(5).fill(0)
    for (let seed = 0; seed < 5000; seed++) counts[sampleWeighted([0, 1, 2, 3, 4], 1, seed, () => 1)[0]!]++
    for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(120)
  })
})
