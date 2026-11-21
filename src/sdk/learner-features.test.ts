import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { openDatabase } from '../lib/server/database'
import { createSidecarApi } from '../lib/server/sidecar'
import { ExerciseAnswerField } from './components/ExerciseAnswerField'
import { poolBankExercises } from './components/NoriAssessment'
import { NoriProgress, progressRows } from './components/NoriProgress'
import { NoriReviewQueue } from './components/NoriReviewQueue'
import { NoriClient, NoriUnsupportedError, type ExerciseSnapshot, type FetchFn } from './index'

const BASE_URL = 'http://127.0.0.1:3001/api/nori/v1'
const COURSE = 'ml/basics'
const dirs: string[] = []
const clients: NoriClient[] = []

afterEach(() => {
  while (clients.length) clients.pop()!.dispose()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function sidecar(clock = { now: 1_000_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'nori-learner-sdk-'))
  dirs.push(dir)
  const api = createSidecarApi(openDatabase(join(dir, 'nori.sqlite')), { now: () => clock.now })
  const fetchFn: FetchFn = (input, init) => api(new Request(String(input), init))
  return { fetchFn, clock }
}

function makeClient(fetchFn: FetchFn) {
  const client = new NoriClient({ baseUrl: BASE_URL, fetchFn, retryBaseMs: 60_000 })
  clients.push(client)
  return client
}

/** A sidecar from before these endpoints: /health has no features. */
function olderSidecar(fetchFn: FetchFn): FetchFn {
  return async (input, init) => {
    const res = await fetchFn(input, init)
    if (!String(input).endsWith('/health')) return res
    const { features: _features, ...older } = await res.json()
    return Response.json(older)
  }
}

const mcq: ExerciseSnapshot = { type: 'multiple_choice', prompt: 'Pick', options: ['A', 'B'], answer: 'A', explanation: 'A is right.' }
const select: ExerciseSnapshot = { type: 'multiple_select', prompt: 'Pick all', options: ['A', 'B', 'C'], answer: 'A\nC', explanation: '' }

describe('review queue answered in place', () => {
  test('answering a due item from its queue entry clears it from the due list', async () => {
    const { fetchFn } = sidecar()
    const client = makeClient(fetchFn)
    await client.createAttempt({ courseKey: COURSE, lessonKey: '01-a', exerciseKey: 'q-1', exerciseSnapshot: select, answer: 'A' })

    const before = await client.getReviewQueueSummary({ courseKey: COURSE })
    const item = before.items[0]!
    expect(item.isDue).toBe(true)
    expect(before.summary.dueNow).toBe(1)

    // What the island does on submit: load the full snapshot, then record the answer with an id.
    const latest = await client.getAttempt(item.latestAttempt.id)
    const created = await client.createAttempt({
      id: crypto.randomUUID(),
      courseKey: item.courseKey,
      lessonKey: item.lessonKey,
      exerciseKey: item.exerciseKey,
      contentHash: latest.contentHash,
      exerciseSnapshot: latest.exerciseSnapshot,
      answer: 'C\nA',
    })
    expect(created.correct).toBe(1)

    const after = await client.getReviewQueueSummary({ courseKey: COURSE })
    expect(after.summary.dueNow).toBe(0)
    expect(after.items[0]!).toMatchObject({ isDue: false, intervalDays: 1, attemptCount: 2 })
  })

  test('the shared answer field marks the right options and a wrong pick once answered', () => {
    const render = (props: Partial<Parameters<typeof ExerciseAnswerField>[0]>) =>
      renderToStaticMarkup(
        createElement(ExerciseAnswerField, {
          type: 'multiple_select',
          options: select.options,
          name: 'n',
          promptId: 'p',
          value: '',
          onChange: () => undefined,
          ...props,
        }),
      )
    const open = render({ value: 'A\nB' })
    expect(open).toContain('role="group"')
    expect(open.match(/checked=""/g)?.length).toBe(2)
    expect(open).not.toContain('nori-option--correct')

    const answered = render({ value: 'A\nB', reveal: { expected: 'A\nC', submitted: 'A\nB' }, disabled: true })
    expect(answered.match(/nori-option--correct/g)?.length).toBe(2)
    expect(answered.match(/nori-option--incorrect/g)?.length).toBe(1)

    expect(render({ type: 'multiple_choice', options: mcq.options, value: 'B' })).toContain('role="radiogroup"')
    expect(render({ type: 'cloze', options: [] })).toContain('Type exact answer')
    expect(render({ type: 'code', options: [] })).toContain('nori-textarea--code')
  })

  test('the queue and progress islands render on the server without data', () => {
    expect(renderToStaticMarkup(createElement(NoriReviewQueue, { courseKey: COURSE }))).toContain('Spaced recall')
    expect(renderToStaticMarkup(createElement(NoriProgress, { courseKey: COURSE }))).toContain('Course progress')
  })
})

describe('progress client', () => {
  test('getProgress returns per-lesson rows; the island lists untouched lessons in course order', async () => {
    const { fetchFn } = sidecar()
    const client = makeClient(fetchFn)
    await client.createAttempt({ courseKey: COURSE, lessonKey: '02-b', exerciseKey: 'q-1', exerciseSnapshot: mcq, answer: 'B' })
    const progress = await client.getProgress(COURSE)
    expect(progress.lessons).toMatchObject([{ lessonKey: '02-b', exercisesAttempted: 1, exercisesIncorrect: 1, exercisesDue: 1 }])

    const rows = progressRows([{ key: '01-a', title: 'Intro' }, { key: '02-b' }], [...progress.lessons, { ...progress.lessons[0]!, lessonKey: '' }])
    expect(rows.map((r) => [r.lesson.key, r.progress?.exercisesAttempted ?? null])).toEqual([
      ['01-a', null],
      ['02-b', 1],
      ['', 1],
    ])
  })

  test('an older sidecar gets a clear error instead of a 404 or an unsampled assessment', async () => {
    const { fetchFn } = sidecar()
    const client = makeClient(olderSidecar(fetchFn))
    await expect(client.getProgress(COURSE)).rejects.toBeInstanceOf(NoriUnsupportedError)
    await expect(
      client.createSampledAssessment({
        courseKey: COURSE,
        title: 'Quiz',
        mode: 'untimed',
        items: [{ exerciseKey: 'q-1', exerciseSnapshot: mcq }],
        sample: { count: 1 },
      }),
    ).rejects.toBeInstanceOf(NoriUnsupportedError)
    expect((await client.listAssessmentSummaries(COURSE)).assessments).toEqual([])
  })

  test('createSampledAssessment returns the draw and its seed', async () => {
    const { fetchFn } = sidecar()
    const client = makeClient(fetchFn)
    const items = Array.from({ length: 20 }, (_, i) => ({ lessonKey: '01-a', exerciseKey: `q-${i}`, exerciseSnapshot: { ...mcq, prompt: `Pick ${i}` } }))
    const res = await client.createSampledAssessment({ courseKey: COURSE, title: 'Quiz', mode: 'untimed', items, sample: { count: 4, strategy: 'weak', seed: 99 } })
    expect(res.sample).toEqual({ strategy: 'weak', seed: 99, count: 4, poolSize: 20 })
    expect(res.assessment.items.length).toBe(4)
  })
})

describe('assessment over pooled banks', () => {
  const bank = (lessonKey: string | undefined) => ({
    courseKey: COURSE,
    ...(lessonKey === undefined ? {} : { lessonKey }),
    exercises: [{ key: 'q-1', ...mcq }],
  })

  test('each pooled bank keeps its own lessonKey; the island lessonKey only fills a gap', () => {
    const pooled = poolBankExercises([bank('01-a'), bank('02-b'), bank(undefined)], '00-course')
    expect(pooled.map((ex) => `${ex.lessonKey}/${ex.key}`)).toEqual(['01-a/q-1', '02-b/q-1', '00-course/q-1'])
    // A single bank still takes the island's lessonKey, else its own.
    expect(poolBankExercises([bank('01-a')], '00-course', false)[0]!.lessonKey).toBe('00-course')
    expect(poolBankExercises([bank('01-a')], '', false)[0]!.lessonKey).toBe('01-a')
  })

  test('two lessons that both use q-1 sample together', async () => {
    const { fetchFn } = sidecar()
    const client = makeClient(fetchFn)
    const items = poolBankExercises([bank('01-a'), bank('02-b')], '00-course').map((ex) => ({
      lessonKey: ex.lessonKey,
      exerciseKey: ex.key,
      exerciseSnapshot: mcq,
    }))
    const res = await client.createSampledAssessment({ courseKey: COURSE, title: 'Quiz', mode: 'untimed', items, sample: { count: 2, seed: 1 } })
    expect(res.assessment.items.map((i) => i.lessonKey).sort()).toEqual(['01-a', '02-b'])
  })
})
