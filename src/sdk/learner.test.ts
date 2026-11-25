import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/server/database'
import { createSidecarApi } from '../lib/server/sidecar'
import { AssessmentAnswerSync, createCountdown, formatCountdown, localDeadline, MAX_ANSWER_CHARS, openAssessment } from './assessment-sync'
import {
  loadLocalDrafts,
  NoriClient,
  NoriNetworkError,
  resendLocalDrafts,
  saveLocalDraft,
  toAssessmentSummary,
  toAttemptSummary,
  verifyCodeInBrowser,
  type ConnectionState,
  type ExerciseSnapshot,
  type FetchFn,
  type PracticeExercise,
} from './index'

const COURSE = 'ml/basics'
const BASE_URL = 'http://127.0.0.1:3001/api/nori/v1'
const dirs: string[] = []
const clients: NoriClient[] = []

function sidecarFetch(now?: () => number): FetchFn {
  const dir = mkdtempSync(join(tmpdir(), 'nori-learner-'))
  dirs.push(dir)
  const api = createSidecarApi(openDatabase(join(dir, 'nori.sqlite')), { now })
  return (input, init) => api(new Request(input instanceof Request ? input : String(input), init))
}

function makeClient(options: ConstructorParameters<typeof NoriClient>[0]): NoriClient {
  const client = new NoriClient({ baseUrl: 'http://127.0.0.1:3001/api/nori/v1', ...options })
  clients.push(client)
  return client
}

/** A fetch that never answers on its own, only rejecting when its signal aborts. */
const hangingFetch: FetchFn = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
  })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const mcq: ExerciseSnapshot = {
  type: 'multiple_choice',
  prompt: 'Pick one',
  options: ['A', 'B'],
  answer: 'A',
  explanation: 'A is right.',
}
const written: ExerciseSnapshot = { type: 'written', prompt: 'Explain', options: [], answer: 'Because.', explanation: '' }

const storage = new Map<string, string>()
const memoryStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
}
let originalStorage: unknown

beforeEach(() => {
  originalStorage = (globalThis as { localStorage?: unknown }).localStorage
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true, writable: true })
  storage.clear()
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: originalStorage, configurable: true, writable: true })
  while (clients.length) clients.pop()!.dispose()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('NoriClient connection handling', () => {
  test('a hanging sidecar times out into the offline state', async () => {
    const client = makeClient({ fetchFn: hangingFetch, timeoutMs: 20, retryBaseMs: 60_000 })
    const states: ConnectionState[] = []
    client.subscribe((s) => states.push(s))
    const error = await client.listPractice({ courseKey: COURSE }).catch((e) => e)
    expect(error).toBeInstanceOf(NoriNetworkError)
    expect(String(error.message)).toContain('did not respond')
    expect(client.connectionState).toBe('offline')
    expect(states).toEqual(['offline'])
  })

  test('LLM calls get the longer timeout', async () => {
    const client = makeClient({ fetchFn: hangingFetch, timeoutMs: 10, llmTimeoutMs: 80, retryBaseMs: 60_000 })
    const started = Date.now()
    await client.requestFeedback('attempt-1').catch(() => undefined)
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
  })

  test('a caller abort does not mark the sidecar offline', async () => {
    const client = makeClient({ fetchFn: hangingFetch, timeoutMs: 1_000 })
    const controller = new AbortController()
    const pending = client.createAttempt(
      { courseKey: COURSE, exerciseKey: 'e', exerciseSnapshot: written, answer: 'x' },
      controller.signal,
    )
    controller.abort()
    await pending.catch(() => undefined)
    expect(client.connectionState).toBe('checking')
  })

  test('retries with backoff while offline and comes back online', async () => {
    const real = sidecarFetch()
    let down = true
    let healthCalls = 0
    const client = makeClient({
      fetchFn: (input, init) => {
        if (String(input).endsWith('/health')) healthCalls++
        return down ? Promise.reject(new TypeError('connection refused')) : real(input, init)
      },
      retryBaseMs: 10,
      retryMaxMs: 40,
    })
    await client.listPractice({ courseKey: COURSE }).catch(() => undefined)
    expect(client.connectionState).toBe('offline')
    await sleep(50)
    expect(healthCalls).toBeGreaterThanOrEqual(2)
    expect(client.connectionState).toBe('offline')
    down = false
    await sleep(80)
    expect(client.connectionState).toBe('online')
  })

  test('a gateway error without a sidecar body counts as offline', async () => {
    const client = makeClient({
      fetchFn: async () => new Response('Bad Gateway', { status: 502 }),
      retryBaseMs: 60_000,
    })
    await expect(client.health()).rejects.toBeInstanceOf(NoriNetworkError)
    expect(client.connectionState).toBe('offline')
  })

  test('identical in-flight GETs share one request and a data call marks the sidecar online', async () => {
    const real = sidecarFetch()
    const calls: string[] = []
    const client = makeClient({
      fetchFn: (input, init) => {
        calls.push(new URL(String(input)).pathname)
        return real(input, init)
      },
    })
    const [a, b, h1, h2] = await Promise.all([
      client.listPractice({ courseKey: COURSE, lessonKey: 'l' }),
      client.listPractice({ courseKey: COURSE, lessonKey: 'l' }),
      client.health(),
      client.health(),
    ])
    expect(a).toEqual(b)
    expect(h1.ok && h2.ok).toBe(true)
    expect(calls.filter((p) => p.endsWith('/practice'))).toHaveLength(1)
    expect(calls.filter((p) => p.endsWith('/health'))).toHaveLength(1)
    expect(client.connectionState).toBe('online')
    await client.health()
    expect(calls.filter((p) => p.endsWith('/health'))).toHaveLength(1)
  })
})

describe('offline drafts', () => {
  test('resendLocalDrafts sends stored drafts once and clears them', async () => {
    const client = makeClient({ fetchFn: sidecarFetch() })
    const exercises: PracticeExercise[] = [{ key: 'q1', ...mcq }, { key: 'q2', ...written }]
    saveLocalDraft(COURSE, 'l', { exerciseKey: 'q1', answer: 'A', updatedAt: 1, correct: 1 })
    saveLocalDraft(COURSE, 'l', { exerciseKey: 'q2', answer: 'My words', updatedAt: 2, correct: null })

    const [first, second] = await Promise.all([
      resendLocalDrafts({ client, courseKey: COURSE, lessonKey: 'l', exercises }),
      resendLocalDrafts({ client, courseKey: COURSE, lessonKey: 'l', exercises }),
    ])
    expect(second).toBe(first)
    expect(first.sent.map((a) => a.exerciseKey).sort()).toEqual(['q1', 'q2'])
    expect(first.drafts).toEqual({})
    expect(loadLocalDrafts(COURSE, 'l')).toEqual({})
    const recorded = await client.listPractice({ courseKey: COURSE, lessonKey: 'l' })
    expect(recorded.attempts).toHaveLength(2)
  })

  test('resendLocalDrafts keeps drafts when the sidecar is still unreachable', async () => {
    const client = makeClient({ fetchFn: async () => Promise.reject(new TypeError('down')), retryBaseMs: 60_000 })
    saveLocalDraft(COURSE, 'l', { exerciseKey: 'q1', answer: 'A', updatedAt: 1 })
    const result = await resendLocalDrafts({ client, courseKey: COURSE, lessonKey: 'l', exercises: [{ key: 'q1', ...mcq }] })
    expect(result.sent).toEqual([])
    expect(Object.keys(result.drafts)).toEqual(['q1'])
  })
})

describe('assessment auto-save and timer', () => {
  test('submit flushes debounced answers so none are graded blank', async () => {
    const client = makeClient({ fetchFn: sidecarFetch() })
    const created = await client.createAssessment({
      courseKey: COURSE,
      title: 'Quiz',
      mode: 'untimed',
      items: [
        { exerciseKey: 'q1', exerciseSnapshot: mcq },
        { exerciseKey: 'q2', exerciseSnapshot: written },
      ],
    })
    const started = await client.startAssessment(created.id)
    const states: Record<string, string>[] = []
    const sync = new AssessmentAnswerSync({
      client,
      assessment: started,
      debounceMs: 60_000,
      onStateChange: (s) => states.push(s),
    })
    const [item1, item2] = started.items
    sync.setAnswer(item1!.id, 'A')
    sync.setAnswer(item2!.id, 'draft')
    sync.setAnswer(item2!.id, 'Final words')
    expect(sync.hasUnsaved).toBe(true)

    const finalized = await sync.submit()
    expect(finalized.status).toBe('submitted')
    expect(finalized.items.find((i) => i.id === item1!.id)?.answer).toBe('A')
    expect(finalized.items.find((i) => i.id === item1!.id)?.result?.correct).toBe(1)
    expect(finalized.items.find((i) => i.id === item2!.id)?.answer).toBe('Final words')
    expect(states.at(-1)).toEqual({ [item1!.id]: 'saved', [item2!.id]: 'saved' })
    sync.dispose()
  })

  test('answers auto-save after the debounce without an explicit save', async () => {
    const client = makeClient({ fetchFn: sidecarFetch() })
    const created = await client.createAssessment({
      courseKey: COURSE,
      title: 'Quiz',
      mode: 'untimed',
      items: [{ exerciseKey: 'q2', exerciseSnapshot: written }],
    })
    const started = await client.startAssessment(created.id)
    const sync = new AssessmentAnswerSync({ client, assessment: started, debounceMs: 10 })
    sync.setAnswer(started.items[0]!.id, 'Typed answer')
    await sleep(60)
    expect(sync.hasUnsaved).toBe(false)
    const reloaded = await client.getAssessment(created.id)
    expect(reloaded.items[0]!.answer).toBe('Typed answer')
    sync.dispose()
  })

  test('formatCountdown shows mm:ss', () => {
    expect(formatCountdown(15 * 60_000)).toBe('15:00')
    expect(formatCountdown(61_001)).toBe('01:02')
    expect(formatCountdown(999)).toBe('00:01')
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(-5)).toBe('00:00')
  })

  test('createCountdown wakes on second boundaries and expires exactly at the deadline', () => {
    let clock = 0
    const ticks: number[] = []
    const delays: number[] = []
    let expiredAt = null as number | null
    let pending: (() => void) | null = null
    createCountdown({
      deadline: 2_500,
      now: () => clock,
      schedule: (fn, ms) => {
        delays.push(ms)
        pending = () => {
          clock += ms
          fn()
        }
        return () => {
          pending = null
        }
      },
      onTick: (ms) => ticks.push(ms),
      onExpire: () => {
        expiredAt = clock
      },
    })
    while (pending) {
      const run: () => void = pending
      pending = null
      run()
    }
    expect(delays).toEqual([500, 1_000, 1_000])
    expect(ticks).toEqual([2_500, 2_000, 1_000, 0])
    expect(ticks.map(formatCountdown)).toEqual(['00:03', '00:02', '00:01', '00:00'])
    expect(expiredAt).toBe(2_500)
  })
})

describe('code check labelling', () => {
  test('Python checks are reported as not executed', async () => {
    const ref = '```python\nemb = torch.nn.Embedding(50257, 64)\n```'
    const result = await verifyCodeInBrowser('emb = torch.nn.Embedding(50257, 64)', ref)
    expect(result.executed).toBe(false)
    expect(result.summary).toContain('not executed')
  })
})

const isCreate = (input: RequestInfo | URL, init?: RequestInit) =>
  init?.method === 'POST' && String(input).endsWith('/practice/attempts')

describe('idempotent attempt creation', () => {
  test('a draft stored after a lost response is recorded once when re-sent', async () => {
    const real = sidecarFetch()
    let loseNext = true
    const client = makeClient({
      retryBaseMs: 60_000,
      fetchFn: async (input, init) => {
        if (isCreate(input, init) && loseNext) {
          loseNext = false
          await real(input, init) // the sidecar records it...
          throw new TypeError('connection reset') // ...but the response never arrives
        }
        return real(input, init)
      },
    })
    const exercise: PracticeExercise = { key: 'q1', ...mcq }
    // What NoriPractice does: reserve an id, send, keep it on the draft after a network error.
    const attemptId = crypto.randomUUID()
    const lost = await client
      .createAttempt({ id: attemptId, courseKey: COURSE, lessonKey: 'l', exerciseKey: 'q1', exerciseSnapshot: mcq, answer: 'A' })
      .catch((e) => e)
    expect(lost).toBeInstanceOf(NoriNetworkError)
    saveLocalDraft(COURSE, 'l', { exerciseKey: 'q1', attemptId, answer: 'A', updatedAt: 1 })

    const result = await resendLocalDrafts({ client, courseKey: COURSE, lessonKey: 'l', exercises: [exercise] })
    expect(result.sent.map((a) => a.id)).toEqual([attemptId])
    expect(result.drafts).toEqual({})
    expect((await client.listPractice({ courseKey: COURSE, lessonKey: 'l' })).attempts).toHaveLength(1)
  })

  test('a legacy draft gets its id stored before sending, so a lost response does not duplicate it', async () => {
    const real = sidecarFetch()
    let loseNext = true
    const client = makeClient({
      retryBaseMs: 60_000,
      fetchFn: async (input, init) => {
        if (isCreate(input, init) && loseNext) {
          loseNext = false
          await real(input, init)
          throw new TypeError('connection reset')
        }
        return real(input, init)
      },
    })
    const exercises: PracticeExercise[] = [{ key: 'q2', ...written }]
    saveLocalDraft(COURSE, 'l', { exerciseKey: 'q2', answer: 'My words', updatedAt: 1 })
    const first = await resendLocalDrafts({ client, courseKey: COURSE, lessonKey: 'l', exercises })
    expect(first.sent).toEqual([])
    expect(first.drafts.q2?.attemptId).toBeString()
    const second = await resendLocalDrafts({ client, courseKey: COURSE, lessonKey: 'l', exercises })
    expect(second.sent.map((a) => a.id)).toEqual([first.drafts.q2!.attemptId!])
    expect((await client.listPractice({ courseKey: COURSE, lessonKey: 'l' })).attempts).toHaveLength(1)
  })

  test('two clients (tabs) sending the same draft leave one attempt', async () => {
    const real = sidecarFetch()
    const tabA = makeClient({ fetchFn: real })
    const tabB = makeClient({ fetchFn: real })
    const input = { id: crypto.randomUUID(), courseKey: COURSE, lessonKey: 'l', exerciseKey: 'q2', exerciseSnapshot: written, answer: 'Same' }
    const [a, b] = await Promise.all([tabA.createAttempt(input), tabB.createAttempt(input)])
    expect(a.id).toBe(input.id)
    expect(b).toEqual(a)
    expect((await tabA.listPractice({ courseKey: COURSE, lessonKey: 'l' })).attempts).toHaveLength(1)
  })

  test('reusing an attempt id for another exercise is rejected', async () => {
    const client = makeClient({ fetchFn: sidecarFetch() })
    const id = crypto.randomUUID()
    await client.createAttempt({ id, courseKey: COURSE, lessonKey: 'l', exerciseKey: 'q2', exerciseSnapshot: written, answer: 'x' })
    const err = await client
      .createAttempt({ id, courseKey: COURSE, lessonKey: 'l', exerciseKey: 'q9', exerciseSnapshot: written, answer: 'x' })
      .catch((e) => e)
    expect(err.status).toBe(409)
  })
})

describe('response bodies and health', () => {
  test('a 200 with a non-JSON body is an error, not an empty success', async () => {
    const client = makeClient({
      fetchFn: async () => new Response('<!doctype html><p>app shell</p>', { status: 200 }),
      retryBaseMs: 60_000,
    })
    await expect(client.listPractice({ courseKey: COURSE })).rejects.toBeInstanceOf(NoriNetworkError)
    expect(client.connectionState).toBe('offline')
  })

  test('a stalled body times out into the offline state', async () => {
    const client = makeClient({
      timeoutMs: 20,
      retryBaseMs: 60_000,
      fetchFn: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"attempts":'))
              init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason))
            },
          }),
          { status: 200 },
        ),
    })
    const err = await client.listPractice({ courseKey: COURSE }).catch((e) => e)
    expect(err).toBeInstanceOf(NoriNetworkError)
    expect(client.connectionState).toBe('offline')
  })

  test('the health result is refreshed after its TTL', async () => {
    const real = sidecarFetch()
    let healthCalls = 0
    const client = makeClient({
      fetchFn: (input, init) => {
        if (String(input).endsWith('/health')) healthCalls++
        return real(input, init)
      },
    })
    try {
      setSystemTime(new Date('2026-11-21T00:00:00Z'))
      await client.health()
      await client.health()
      expect(healthCalls).toBe(1)
      setSystemTime(new Date('2026-11-21T00:01:01Z'))
      await client.health()
      expect(healthCalls).toBe(2)
    } finally {
      setSystemTime()
    }
  })
})

describe('assessment open, submit and unload', () => {
  test('opening an assessment from a stale list starts the countdown from fresh server time', async () => {
    let serverNow = 1_000_000
    const client = makeClient({ fetchFn: sidecarFetch(() => serverNow) })
    const created = await client.createAssessment({
      courseKey: COURSE,
      title: 'Timed',
      mode: 'timed',
      durationSeconds: 60,
      items: [{ exerciseKey: 'q1', exerciseSnapshot: mcq }],
    })
    await client.startAssessment(created.id)
    const listed = (await client.listAssessments(COURSE)).assessments[0]!
    expect(listed.remainingMs).toBe(60_000)

    // The learner clicks the list entry 30 s later.
    serverNow += 30_000
    const localNow = 5_000_000
    const opened = await openAssessment(client, created.id, () => localNow)
    expect(opened.deadline! - localNow).toBe(30_000)
    // Using the stale list entry at click time would overstate the time left.
    expect(localDeadline(listed, localNow)! - localNow).toBe(60_000)
  })

  test('submit retries once when another save moved the version', async () => {
    const client = makeClient({ fetchFn: sidecarFetch() })
    const created = await client.createAssessment({
      courseKey: COURSE,
      title: 'Quiz',
      mode: 'untimed',
      items: [{ exerciseKey: 'q1', exerciseSnapshot: mcq }],
    })
    const started = await client.startAssessment(created.id)
    const sync = new AssessmentAnswerSync({ client, assessment: started, debounceMs: 60_000 })
    // Another tab saves an answer, so this sync's version is now stale.
    await client.saveAssessmentAnswer(created.id, started.items[0]!.id, 'B', started.version)
    const finalized = await sync.submit()
    expect(finalized.status).toBe('submitted')
    sync.dispose()
  })

  test('flushOnPageHide sends unsaved answers as keepalive requests', async () => {
    const real = sidecarFetch()
    const keepalive: boolean[] = []
    const client = makeClient({
      fetchFn: (input, init) => {
        if (String(input).endsWith('/answers')) keepalive.push(Boolean(init?.keepalive))
        return real(input, init)
      },
    })
    const created = await client.createAssessment({
      courseKey: COURSE,
      title: 'Quiz',
      mode: 'untimed',
      items: [{ exerciseKey: 'q2', exerciseSnapshot: written }],
    })
    const started = await client.startAssessment(created.id)
    const sync = new AssessmentAnswerSync({ client, assessment: started, debounceMs: 60_000 })
    sync.setAnswer(started.items[0]!.id, 'Leaving now')
    sync.flushOnPageHide()
    await sleep(20)
    expect(keepalive).toEqual([true])
    expect((await client.getAssessment(created.id)).items[0]!.answer).toBe('Leaving now')
    sync.dispose()
  })
})

describe('second review fixes', () => {
  async function startQuiz(client: NoriClient, durationSeconds?: number) {
    const created = await client.createAssessment({
      courseKey: COURSE,
      title: 'Quiz',
      mode: durationSeconds ? 'timed' : 'untimed',
      durationSeconds,
      items: [
        { exerciseKey: 'w1', exerciseSnapshot: written },
        { exerciseKey: 'w2', exerciseSnapshot: written },
        { exerciseKey: 'w3', exerciseSnapshot: written },
      ],
    })
    return client.startAssessment(created.id)
  }

  test('one over-limit answer does not block saving the others, and submit names it', async () => {
    const client = makeClient({ fetchFn: sidecarFetch() })
    const started = await startQuiz(client)
    const [i1, i2, i3] = started.items
    const states: Record<string, string>[] = []
    let errors: Record<string, string> = {}
    const sync = new AssessmentAnswerSync({
      client,
      assessment: started,
      debounceMs: 60_000,
      onStateChange: (s, e) => {
        states.push(s)
        errors = e
      },
    })
    sync.setAnswer(i1!.id, 'x'.repeat(MAX_ANSWER_CHARS + 1))
    sync.setAnswer(i2!.id, 'Second')
    sync.setAnswer(i3!.id, 'Third')

    await sync.flush()
    expect(states.at(-1)).toEqual({ [i1!.id]: 'rejected', [i2!.id]: 'saved', [i3!.id]: 'saved' })
    expect(errors[i1!.id]).toContain('20,000')
    const saved = await client.getAssessment(started.id)
    expect(saved.items.map((i) => i.answer)).toEqual([null, 'Second', 'Third'])

    const refused = await sync.submit().catch((e) => e)
    expect(String(refused.message)).toContain('#1')
    expect((await client.getAssessment(started.id)).status).toBe('active')

    // Fixing the answer clears the rejection and submit goes through.
    sync.setAnswer(i1!.id, 'First')
    const finalized = await sync.submit()
    expect(finalized.items.map((i) => i.answer)).toEqual(['First', 'Second', 'Third'])
    sync.dispose()
  })

  test('valid answers are on the server when a timed assessment expires despite a rejected one', async () => {
    let serverNow = 1_000_000
    const client = makeClient({ fetchFn: sidecarFetch(() => serverNow) })
    const started = await startQuiz(client, 60)
    const [i1, i2, i3] = started.items
    const sync = new AssessmentAnswerSync({ client, assessment: started, debounceMs: 60_000 })
    sync.setAnswer(i1!.id, 'x'.repeat(MAX_ANSWER_CHARS + 1))
    sync.setAnswer(i2!.id, 'Second')
    sync.setAnswer(i3!.id, 'Third')
    await sync.flush()
    serverNow += 61_000
    const expired = await client.getAssessment(started.id)
    expect(expired.status).toBe('expired')
    expect(expired.items.map((i) => i.answer)).toEqual([null, 'Second', 'Third'])
    sync.dispose()
  })

  test('pagehide flush sends the smallest answers within the keepalive budget', async () => {
    const real = sidecarFetch()
    const sentBytes: number[] = []
    const client = makeClient({
      fetchFn: (input, init) => {
        if (init?.keepalive) sentBytes.push(new TextEncoder().encode(String(init.body)).length)
        return real(input, init)
      },
    })
    const created = await client.createAssessment({
      courseKey: COURSE,
      title: 'Long',
      mode: 'untimed',
      items: [1, 2, 3, 4].map((n) => ({ exerciseKey: `w${n}`, exerciseSnapshot: written })),
    })
    const started = await client.startAssessment(created.id)
    const sync = new AssessmentAnswerSync({ client, assessment: started, debounceMs: 60_000 })
    started.items.forEach((item, n) => sync.setAnswer(item.id, 'y'.repeat(19_000 + n)))
    sync.flushOnPageHide()
    await sleep(30)
    expect(sentBytes).toHaveLength(3)
    expect(sentBytes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000)
    const answers = (await client.getAssessment(created.id)).items.map((i) => i.answer?.length ?? null)
    expect(answers).toEqual([19_000, 19_001, 19_002, null])
    expect(sync.hasUnsaved).toBe(true)
    sync.dispose()
  })

  test('a disposed sync makes no more callbacks', async () => {
    const client = makeClient({ fetchFn: sidecarFetch() })
    const started = await startQuiz(client)
    let calls = 0
    const sync = new AssessmentAnswerSync({
      client,
      assessment: started,
      debounceMs: 60_000,
      onUpdate: () => calls++,
      onStateChange: () => calls++,
    })
    sync.setAnswer(started.items[0]!.id, 'Late')
    const before = calls
    const flushing = sync.flush()
    sync.dispose()
    await flushing
    expect(calls).toBe(before)
    expect((await client.getAssessment(started.id)).items[0]!.answer).toBe('Late')
  })

  test('a non-JSON 404 from in front of the sidecar counts as unreachable', async () => {
    const client = makeClient({
      fetchFn: async () => new Response('Not Found', { status: 404 }),
      retryBaseMs: 60_000,
    })
    await expect(client.createAttempt({ courseKey: COURSE, exerciseKey: 'q', exerciseSnapshot: written, answer: 'x' })).rejects.toBeInstanceOf(
      NoriNetworkError,
    )
    expect(client.connectionState).toBe('offline')
  })

  test('the same attempt id with a different answer is rejected', async () => {
    const client = makeClient({ fetchFn: sidecarFetch() })
    const id = crypto.randomUUID()
    const base = { id, courseKey: COURSE, lessonKey: 'l', exerciseKey: 'q2', exerciseSnapshot: written }
    await client.createAttempt({ ...base, answer: 'One' })
    const err = await client.createAttempt({ ...base, answer: 'Two' }).catch((e) => e)
    expect(err.status).toBe(409)
  })

  test('every legacy draft has a stored id before the first draft is sent', async () => {
    const real = sidecarFetch()
    const idsAtFirstSend: (string | undefined)[] = []
    const client = makeClient({
      fetchFn: (input, init) => {
        if (isCreate(input, init) && !idsAtFirstSend.length) {
          idsAtFirstSend.push(...Object.values(loadLocalDrafts(COURSE, 'l')).map((d) => d.attemptId))
        }
        return real(input, init)
      },
    })
    saveLocalDraft(COURSE, 'l', { exerciseKey: 'a', answer: 'One', updatedAt: 1 })
    saveLocalDraft(COURSE, 'l', { exerciseKey: 'b', answer: 'Two', updatedAt: 2 })
    const exercises: PracticeExercise[] = [
      { key: 'a', ...written },
      { key: 'b', ...written },
    ]
    const result = await resendLocalDrafts({ client, courseKey: COURSE, lessonKey: 'l', exercises })
    expect(idsAtFirstSend).toHaveLength(2)
    expect(idsAtFirstSend.every((id) => typeof id === 'string')).toBe(true)
    expect(result.sent).toHaveLength(2)
  })
})

describe('auto-save recovery', () => {
  async function startWritten(client: NoriClient) {
    const created = await client.createAssessment({
      courseKey: COURSE,
      title: 'Quiz',
      mode: 'untimed',
      items: [{ exerciseKey: 'w1', exerciseSnapshot: written }],
    })
    return client.startAssessment(created.id)
  }

  test('an answer whose save failed before closing is saved when the assessment is reopened', async () => {
    const real = sidecarFetch()
    let down = false
    const fetchFn: FetchFn = (input, init) => (down ? Promise.reject(new TypeError('offline')) : real(input, init))
    const client = makeClient({ fetchFn, retryBaseMs: 60_000 })
    const started = await startWritten(client)
    const itemId = started.items[0]!.id

    down = true
    const first = new AssessmentAnswerSync({ client, assessment: started, debounceMs: 60_000, retryBaseMs: 60_000 })
    first.setAnswer(itemId, 'Typed while offline')
    await first.flush().catch(() => undefined)
    first.dispose() // the learner closed the assessment

    down = false
    const reopened = await client.getAssessment(started.id)
    expect(reopened.items[0]!.answer).toBeNull()
    const states: Record<string, string>[] = []
    const second = new AssessmentAnswerSync({
      client,
      assessment: reopened,
      debounceMs: 5,
      localAnswers: { [itemId]: 'Typed while offline' },
      onStateChange: (s) => states.push(s),
    })
    expect(second.hasUnsaved).toBe(true)
    await sleep(60)
    expect((await client.getAssessment(started.id)).items[0]!.answer).toBe('Typed while offline')
    expect(states.at(-1)).toEqual({ [itemId]: 'saved' })
    second.dispose()
  })

  test('local answers equal to the server are not re-sent', async () => {
    const client = makeClient({ fetchFn: sidecarFetch() })
    const started = await startWritten(client)
    const itemId = started.items[0]!.id
    const saved = await client.saveAssessmentAnswer(started.id, itemId, 'Same', started.version)
    const sync = new AssessmentAnswerSync({ client, assessment: saved, localAnswers: { [itemId]: 'Same' } })
    expect(sync.hasUnsaved).toBe(false)
    sync.dispose()
  })

  test('a 409 that survives the version retry is retried later, not rejected', async () => {
    const real = sidecarFetch()
    let conflicts = 2
    const client = makeClient({
      fetchFn: async (input, init) => {
        if (String(input).endsWith('/answers') && conflicts > 0) {
          conflicts--
          const id = String(input).split('/assessments/')[1]!.split('/')[0]!
          const current = await (await real(`${BASE_URL}/assessments/${id}`)).json()
          return Response.json({ error: 'This assessment changed. Reload it.', assessment: current.assessment }, { status: 409 })
        }
        return real(input, init)
      },
    })
    const started = await startWritten(client)
    const itemId = started.items[0]!.id
    const states: Record<string, string>[] = []
    const sync = new AssessmentAnswerSync({
      client,
      assessment: started,
      debounceMs: 60_000,
      retryBaseMs: 10,
      onStateChange: (s) => states.push(s),
    })
    sync.setAnswer(itemId, 'Contended')
    await sync.flush()
    expect(states.at(-1)).toEqual({ [itemId]: 'error' })
    await sleep(80)
    expect(states.at(-1)).toEqual({ [itemId]: 'saved' })
    expect((await client.getAssessment(started.id)).items[0]!.answer).toBe('Contended')
    sync.dispose()
  })

  test('answers that hit a network error are retried with backoff without another edit', async () => {
    const real = sidecarFetch()
    let failures = 2
    const attemptsAt: number[] = []
    const client = makeClient({
      retryBaseMs: 60_000,
      fetchFn: (input, init) => {
        if (String(input).endsWith('/answers')) {
          attemptsAt.push(Date.now())
          if (failures-- > 0) return Promise.reject(new TypeError('offline'))
        }
        return real(input, init)
      },
    })
    const started = await startWritten(client)
    const sync = new AssessmentAnswerSync({ client, assessment: started, debounceMs: 60_000, retryBaseMs: 15, retryMaxMs: 100 })
    sync.setAnswer(started.items[0]!.id, 'Eventually')
    await sync.flush().catch(() => undefined)
    await sleep(150)
    expect(attemptsAt).toHaveLength(3)
    expect(sync.hasUnsaved).toBe(false)
    expect((await client.getAssessment(started.id)).items[0]!.answer).toBe('Eventually')
    sync.dispose()
  })
})

describe('summary client calls', () => {
  test('islands read slim lists and fetch the full attempt on demand', async () => {
    const client = makeClient({ fetchFn: sidecarFetch() })
    const created = await client.createAttempt({ courseKey: COURSE, lessonKey: 'l', exerciseKey: 'q2', exerciseSnapshot: written, answer: 'Mine' })
    const { attempts } = await client.listPracticeSummaries({ courseKey: COURSE, lessonKey: 'l' })
    expect(attempts[0]).toMatchObject({ id: created.id, exerciseType: 'written', hasFeedback: false })
    expect(toAttemptSummary(created)).toEqual(attempts[0]!)
    expect((await client.getAttempt(created.id)).exerciseSnapshot.prompt).toBe('Explain')
    const review = await client.getReviewQueueSummary({ courseKey: COURSE })
    expect(review.items[0]!.latestAttempt).toMatchObject({ id: created.id, prompt: 'Explain' })
    const quiz = await client.createAssessment({ courseKey: COURSE, title: 'Q', mode: 'untimed', items: [{ exerciseKey: 'q1', exerciseSnapshot: mcq }] })
    const list = await client.listAssessmentSummaries(COURSE)
    const { serverNow: _a, ...listed } = list.assessments[0]!
    const { serverNow: _b, ...fetched } = toAssessmentSummary(await client.getAssessment(quiz.id))
    expect(listed).toEqual(fetched)
  })
})

describe('older sidecars', () => {
  test('summary calls still work against a sidecar that ignores view=summary', async () => {
    const real = sidecarFetch()
    const client = makeClient({
      fetchFn: (input, init) => {
        const url = new URL(String(input))
        url.searchParams.delete('view')
        return real(url.toString(), init)
      },
    })
    const created = await client.createAttempt({ courseKey: COURSE, lessonKey: 'l', exerciseKey: 'q1', exerciseSnapshot: mcq, answer: 'B' })
    const { attempts } = await client.listPracticeSummaries({ courseKey: COURSE, lessonKey: 'l' })
    expect(attempts[0]).toEqual(toAttemptSummary(created))
    const review = await client.getReviewQueueSummary({ courseKey: COURSE })
    expect(review.items[0]!.latestAttempt).toMatchObject({ id: created.id, exerciseType: 'multiple_choice', options: ['A', 'B'] })
    expect(review.items[0]!.latestAttempt).not.toHaveProperty('exerciseSnapshot')
    await client.createAssessment({ courseKey: COURSE, title: 'Q', mode: 'untimed', items: [{ exerciseKey: 'q1', exerciseSnapshot: mcq }] })
    expect((await client.listAssessmentSummaries(COURSE)).assessments[0]).not.toHaveProperty('items')
  })
})

describe('review follow-ups', () => {
  test('a non-JSON 403 from a proxy counts as unreachable, not rejected', async () => {
    const client = makeClient({
      fetchFn: async () => new Response('<html>Forbidden</html>', { status: 403 }),
      retryBaseMs: 60_000,
    })
    await expect(client.createAttempt({ courseKey: COURSE, exerciseKey: 'q', exerciseSnapshot: written, answer: 'x' })).rejects.toBeInstanceOf(
      NoriNetworkError,
    )
    expect(client.connectionState).toBe('offline')
    client.dispose()
  })

  test('unsubscribing the last listener stops the offline health retry loop', async () => {
    let healthCalls = 0
    const client = makeClient({
      fetchFn: async (input) => {
        if (String(input).endsWith('/health')) healthCalls++
        throw new Error('offline')
      },
      retryBaseMs: 15,
      retryMaxMs: 15,
    })
    const unsub = client.subscribe(() => undefined)
    await client.health().catch(() => undefined)
    expect(client.connectionState).toBe('offline')
    unsub()
    const before = healthCalls
    await sleep(50)
    expect(healthCalls).toBe(before)
  })

  test('typing during an in-flight submit flushes the new edit instead of refusing', async () => {
    const real = sidecarFetch()
    const client = makeClient({ fetchFn: real })
    const created = await client.createAssessment({
      courseKey: COURSE,
      title: 'In-flight',
      mode: 'untimed',
      items: [{ exerciseKey: 'q1', exerciseSnapshot: written }],
    })
    const started = await client.startAssessment(created.id)
    const sync = new AssessmentAnswerSync({ client, assessment: started, debounceMs: 60_000 })
    sync.setAnswer(started.items[0]!.id, 'First')
    const submitting = sync.submit()
    sync.setAnswer(started.items[0]!.id, 'Updated')
    const submitted = await submitting
    expect(submitted.status).toBe('submitted')
    expect(submitted.items[0]!.answer).toBe('Updated')
    sync.dispose()
  })
})
