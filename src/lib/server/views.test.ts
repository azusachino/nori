import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { openDatabase } from './database'
import { buildReviewQueue } from './review'
import { practiceAttempts, sidecarSchema } from './schema'
import { createSidecarApi, type ExerciseSnapshot } from './sidecar'

const dirs: string[] = []

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'nori-views-'))
  dirs.push(dir)
  return openDatabase(join(dir, 'nori.sqlite'))
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const COURSE = 'ml/basics'
const BASE = 'http://127.0.0.1:3001/api/nori/v1'

const mcq: ExerciseSnapshot = { type: 'multiple_choice', prompt: 'Pick one', options: ['A', 'B'], answer: 'A', explanation: 'A is right.' }
const written: ExerciseSnapshot = { type: 'written', prompt: 'Explain', options: [], answer: 'Because.', explanation: 'Reasons.' }

function api(db = tempDb(), now?: () => number) {
  const handle = createSidecarApi(db, { basePath: '/api/nori', now, completeFn: async () => 'Advisory feedback text.' })
  const call = async (path: string, init?: RequestInit) => {
    const res = await handle(new Request(BASE + path, init))
    return { status: res.status, body: (await res.json()) as any }
  }
  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { db, call, post }
}

describe('SQLite connection settings', () => {
  test('openDatabase sets WAL, busy_timeout and synchronous=NORMAL', () => {
    const db = tempDb()
    expect((db.query('PRAGMA journal_mode').get() as any).journal_mode).toBe('wal')
    expect((db.query('PRAGMA busy_timeout').get() as any).timeout).toBe(5000)
    expect((db.query('PRAGMA synchronous').get() as any).synchronous).toBe(1)
    expect((db.query('PRAGMA foreign_keys').get() as any).foreign_keys).toBe(1)
  })
})

describe('summary views', () => {
  test('practice summary drops the snapshot and feedback text; one attempt is fetched in full by id', async () => {
    const { call, post } = api()
    const created = (await post('/practice/attempts', { courseKey: COURSE, lessonKey: 'l1', exerciseKey: 'w', exerciseSnapshot: written, answer: 'Mine' })).body.attempt
    await post(`/practice/attempts/${created.id}/feedback`, {})

    const summary = await call(`/practice?courseKey=${encodeURIComponent(COURSE)}&lessonKey=l1&view=summary`)
    expect(summary.status).toBe(200)
    const item = summary.body.attempts[0]
    expect(item).not.toHaveProperty('exerciseSnapshot')
    expect(item).not.toHaveProperty('feedback')
    expect(item).toMatchObject({ id: created.id, exerciseType: 'written', hasFeedback: true, answer: 'Mine', advisory: true })

    const full = await call(`/practice/attempts/${created.id}`)
    expect(full.body.attempt.feedback).toBe('Advisory feedback text.')
    expect(full.body.attempt.exerciseSnapshot.prompt).toBe('Explain')

    // The default (v1) shape is unchanged.
    const v1 = await call(`/practice?courseKey=${encodeURIComponent(COURSE)}&lessonKey=l1`)
    expect(v1.body.attempts[0].exerciseSnapshot.answer).toBe('Because.')
    expect((await call(`/practice?courseKey=${encodeURIComponent(COURSE)}&view=tiny`)).status).toBe(400)
    expect((await call('/practice/attempts/not-a-uuid')).status).toBe(404)
  })

  test('review summary carries what the island renders and no reference answer', async () => {
    const { call, post } = api()
    await post('/practice/attempts', { courseKey: COURSE, lessonKey: 'l1', exerciseKey: 'q', exerciseSnapshot: mcq, answer: 'B' })
    const res = await call(`/review?courseKey=${encodeURIComponent(COURSE)}&view=summary`)
    const latest = res.body.items[0].latestAttempt
    expect(res.body.items[0].reason).toBe('incorrect')
    expect(latest).toMatchObject({ exerciseType: 'multiple_choice', prompt: 'Pick one', options: ['A', 'B'], answer: 'B', correct: 0 })
    expect(latest).not.toHaveProperty('exerciseSnapshot')
    expect(JSON.stringify(res.body)).not.toContain('A is right.')
  })

  test('assessment summary list has no items and the same counts as the full view', async () => {
    const { call, post } = api(tempDb(), () => 1_000_000)
    const created = (
      await post('/assessments', {
        courseKey: COURSE,
        title: 'Quiz',
        mode: 'untimed',
        items: [
          { exerciseKey: 'q', exerciseSnapshot: mcq },
          { exerciseKey: 'w', exerciseSnapshot: written },
        ],
      })
    ).body.assessment
    const started = (await post(`/assessments/${created.id}/start`, {})).body.assessment
    await post(`/assessments/${created.id}/answers`, { itemId: started.items[0].id, answer: 'A' })
    await post(`/assessments/${created.id}/submit`, {})

    const full = (await call(`/assessments?courseKey=${encodeURIComponent(COURSE)}`)).body.assessments
    const summary = (await call(`/assessments?courseKey=${encodeURIComponent(COURSE)}&view=summary`)).body.assessments
    expect(summary[0]).not.toHaveProperty('items')
    const { items: _items, ...expected } = full[0]
    expect(summary[0]).toEqual(expected)
    expect(summary[0].summary).toMatchObject({ totalItems: 2, answeredCount: 1, deterministicTotal: 1, deterministicCorrect: 1, unscoredCount: 1 })
  })

  test('assessment summary list finalizes an overdue timed assessment', async () => {
    let now = 1_000_000
    const { call, post } = api(tempDb(), () => now)
    const created = (
      await post('/assessments', { courseKey: COURSE, title: 'Timed', mode: 'timed', durationSeconds: 60, items: [{ exerciseKey: 'q', exerciseSnapshot: mcq }] })
    ).body.assessment
    await post(`/assessments/${created.id}/start`, {})
    now += 61_000
    const summary = (await call(`/assessments?courseKey=${encodeURIComponent(COURSE)}&view=summary`)).body.assessments
    expect(summary[0]).toMatchObject({ status: 'expired', remainingMs: null })
  })
})

/** The review queue as computed in JavaScript before it moved into SQL: the reference for the query. */
function referenceQueue(rows: (typeof practiceAttempts.$inferSelect)[], now: number) {
  const DAY = 86_400_000
  const schedule = [1, 3, 7, 14, 30]
  const priority = { incorrect: 0, has_takeaway_note: 1, due_for_recall: 2, scheduled: 3 } as const
  const groups = new Map<string, typeof rows>()
  for (const row of [...rows].sort((a, b) => a.createdAt - b.createdAt)) {
    const key = `${row.courseKey}::${row.lessonKey}::${row.exerciseKey}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const items = [...groups.values()].map((list) => {
    const latest = list[list.length - 1]!
    let streak = 0
    for (let i = list.length - 1; i >= 0 && list[i]!.grading === 'deterministic' && list[i]!.correct === 1; i--) streak++
    const incorrect = latest.grading === 'deterministic' && latest.correct === 0
    const intervalDays = incorrect ? 0 : latest.ownerNote && streak <= 1 ? 1 : streak >= 1 ? schedule[Math.min(streak - 1, 4)]! : 3
    const dueAt = latest.createdAt + intervalDays * DAY
    const isDue = intervalDays === 0 || now >= dueAt
    const reason = incorrect ? 'incorrect' : latest.ownerNote && isDue ? 'has_takeaway_note' : isDue ? 'due_for_recall' : 'scheduled'
    return { id: latest.id, attemptCount: list.length, streak, intervalDays, dueAt, isDue, reason: reason as keyof typeof priority }
  })
  return items.sort((a, b) => priority[a.reason] - priority[b.reason] || a.dueAt - b.dueAt)
}

describe('review queue in SQL', () => {
  test('matches the reference algorithm on varied histories', () => {
    const db = tempDb()
    const orm = drizzle(db, { schema: sidecarSchema })
    const now = 100 * 86_400_000
    let seed = 7
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    for (let i = 0; i < 600; i++) {
      const exercise = Math.floor(rand() * 60)
      const deterministic = exercise % 3 !== 0
      const createdAt = Math.floor(rand() * 99) * 86_400_000 + i
      orm
        .insert(practiceAttempts)
        .values({
          id: crypto.randomUUID(),
          courseKey: COURSE,
          lessonKey: `l${exercise % 7}`,
          exerciseKey: `e${exercise}`,
          contentHash: 'h',
          exerciseSnapshot: JSON.stringify(deterministic ? mcq : written),
          answer: 'x',
          correct: deterministic ? (rand() < 0.75 ? 1 : 0) : null,
          grading: deterministic ? 'deterministic' : 'unscored',
          ownerNote: rand() < 0.2 ? 'note' : '',
          createdAt,
          updatedAt: createdAt,
        })
        .run()
    }
    const expected = referenceQueue(orm.select().from(practiceAttempts).all(), now)
    const actual = buildReviewQueue(orm, { courseKey: COURSE, now })
    expect(actual.items.map((i) => ({ id: i.latestAttempt.id, attemptCount: i.attemptCount, streak: i.streak, intervalDays: i.intervalDays, dueAt: i.dueAt, isDue: i.isDue, reason: i.reason }))).toEqual(expected)
    expect(actual.summary).toEqual({
      totalTracked: expected.length,
      dueNow: expected.filter((i) => i.isDue).length,
      incorrectCount: expected.filter((i) => i.reason === 'incorrect').length,
      scheduledCount: expected.filter((i) => !i.isDue).length,
    })
    const due = buildReviewQueue(orm, { courseKey: COURSE, now, onlyDue: true })
    expect(due.items.map((i) => i.latestAttempt.id)).toEqual(expected.filter((i) => i.isDue).map((i) => i.id))
    expect(due.summary).toEqual(actual.summary)
  })

  test('an empty due list still reports the summary', () => {
    const db = tempDb()
    const orm = drizzle(db, { schema: sidecarSchema })
    orm
      .insert(practiceAttempts)
      .values({ id: crypto.randomUUID(), courseKey: COURSE, lessonKey: 'l', exerciseKey: 'e', contentHash: 'h', exerciseSnapshot: JSON.stringify(mcq), answer: 'A', correct: 1, grading: 'deterministic', createdAt: 0, updatedAt: 0 })
      .run()
    const due = buildReviewQueue(orm, { courseKey: COURSE, now: 1000, onlyDue: true })
    expect(due.items).toEqual([])
    expect(due.summary).toEqual({ totalTracked: 1, dueNow: 0, incorrectCount: 0, scheduledCount: 1 })
  })
})
