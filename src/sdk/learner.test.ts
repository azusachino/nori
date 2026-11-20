import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/server/database'
import { createSidecarApi } from '../lib/server/sidecar'
import { AssessmentAnswerSync, createCountdown, formatCountdown, localDeadline, openAssessment } from './assessment-sync'
import {
  loadLocalDrafts,
  NoriClient,
  NoriNetworkError,
  resendLocalDrafts,
  saveLocalDraft,
  verifyCodeInBrowser,
  type ConnectionState,
  type ExerciseSnapshot,
  type FetchFn,
  type PracticeExercise,
} from './index'

const COURSE = 'ml/basics'
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

  test('createCountdown ticks down to the deadline and expires once', async () => {
    let clock = 0
    const ticks: number[] = []
    let expired = 0
    const stop = createCountdown({
      deadline: 3_000,
      now: () => clock,
      intervalMs: 5,
      onTick: (ms) => {
        ticks.push(ms)
        clock += 1_000
      },
      onExpire: () => expired++,
    })
    await sleep(60)
    stop()
    expect(ticks).toEqual([3_000, 2_000, 1_000, 0])
    expect(expired).toBe(1)
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
