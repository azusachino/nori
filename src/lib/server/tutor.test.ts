import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completeStream, ModelError, type Message } from './ai'
import { openDatabase } from './database'
import { createSidecarApi } from './sidecar'
import { selectTutorHistory, TUTOR_HISTORY_LIMIT, type StreamFn } from './tutor'

const BASE = 'http://127.0.0.1:3001/api/nori/v1'
const dirs: string[] = []
const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'nori-tutor-'))
  dirs.push(dir)
  const db = openDatabase(join(dir, 'nori.sqlite'))
  cleanups.push(() => db.close())
  return db
}

const lesson = { courseKey: 'ai/cs229', lessonKey: '01-glms', lessonTitle: 'GLMs', lessonText: 'Exponential family notes.' }

function post(path: string, body: unknown, init: RequestInit = {}) {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}

type SseEvent = { event: string; data: Record<string, unknown> }

async function readEvents(response: Response): Promise<SseEvent[]> {
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n')
      return { event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) }
    })
}

/** A deferred promise for stepping a fake model by hand. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, opened }
}

describe('tutor history selection', () => {
  const turn = (role: 'user' | 'assistant', n: number, size = 10) => ({ role, content: `${role}${n}`.padEnd(size, '.') })

  test('keeps at most maxTurns recent turns and reports the rest as dropped', () => {
    const rows = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', i))
    const { included, dropped } = selectTutorHistory(rows, 1_000_000)
    expect(included.length).toBe(TUTOR_HISTORY_LIMIT.maxTurns)
    expect(dropped).toBe(20 - TUTOR_HISTORY_LIMIT.maxTurns)
    expect(included.at(-1)).toBe(rows.at(-1)!)
  })

  test('stays within the character budget and never starts with an assistant turn', () => {
    const rows = [turn('user', 0, 100), turn('assistant', 1, 100), turn('user', 2, 100), turn('assistant', 3, 100)]
    // 250 chars fit the last two turns and half of the third, so the history is the last pair.
    expect(selectTutorHistory(rows, 250)).toEqual({ included: rows.slice(2), dropped: 2 })
    // 350 chars would fit an orphan assistant reply; it is left out with its question.
    expect(selectTutorHistory(rows, 350, { maxTurns: 3, maxChars: 10_000 })).toEqual({ included: rows.slice(2), dropped: 2 })
    expect(selectTutorHistory(rows, 50)).toEqual({ included: [], dropped: 4 })
  })
})

describe('POST /v1/tutor/stream', () => {
  test('streams deltas, then saves and returns the same shape as POST /v1/tutor', async () => {
    const db = openTemp()
    let clock = 1_000
    const api = createSidecarApi(db, {
      now: () => ++clock,
      streamFn: async function* () {
        yield '## Why\n'
        yield '- the mean\n'
        yield '- the variance '
      },
    })

    const health = await (await api(new Request(`${BASE}/health`))).json()
    expect(health.features).toContain('tutor-stream')

    const res = await api(post('/tutor/stream', { ...lesson, message: 'Why convex?' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toStartWith('text/event-stream')
    const events = await readEvents(res)
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'delta', 'delta', 'done'])
    expect(events[0]!.data.context).toMatchObject({ historyTurnsIncluded: 0, historyTurnsDropped: 0 })
    expect(events.slice(1, 4).map((e) => e.data.text).join('')).toBe('## Why\n- the mean\n- the variance ')
    const done = events[4]!.data as { revision: number; turns: { role: string; content: string }[] }
    expect(done.revision).toBe(2)
    expect(done.turns.map((t) => [t.role, t.content])).toEqual([
      ['user', 'Why convex?'],
      ['assistant', '## Why\n- the mean\n- the variance'],
    ])

    const session = await (await api(new Request(`${BASE}/tutor?courseKey=ai/cs229&lessonKey=01-glms`))).json()
    expect(session.turns).toEqual(done.turns)
    expect(session.historyLimit).toEqual(TUTOR_HISTORY_LIMIT)
  })

  test('validation errors are plain JSON before any stream starts', async () => {
    const api = createSidecarApi(openTemp(), { streamFn: async function* () {} })
    const res = await api(post('/tutor/stream', { ...lesson, message: '' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('message')
  })

  test('a provider failure mid-stream ends with an error event and saves nothing', async () => {
    const db = openTemp()
    const api = createSidecarApi(db, {
      streamFn: async function* () {
        yield 'partial'
        throw new ModelError('The model provider stopped responding.')
      },
    })
    const events = await readEvents(await api(post('/tutor/stream', { ...lesson, message: 'Q' })))
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'error'])
    expect(events[2]!.data).toEqual({ status: 502, error: 'The model provider stopped responding.' })
    expect((db.query('SELECT COUNT(*) AS c FROM sidecar_tutor_turns').get() as { c: number }).c).toBe(0)
  })

  test('another exchange saved meanwhile ends the stream with a 409 error event', async () => {
    const db = openTemp()
    let interleave = true
    const api = createSidecarApi(db, {
      completeFn: async () => 'other tab',
      streamFn: async function* () {
        if (interleave) {
          interleave = false
          await api(post('/tutor', { ...lesson, message: 'from another tab' }))
        }
        yield 'late'
      },
    })
    const events = await readEvents(await api(post('/tutor/stream', { ...lesson, message: 'Q' })))
    expect(events.at(-1)).toEqual({ event: 'error', data: expect.objectContaining({ status: 409 }) })
  })

  test('cancelling the response body aborts the model request and saves nothing', async () => {
    const db = openTemp()
    const firstChunkSent = gate()
    let modelSignal: AbortSignal | undefined
    const streamFn: StreamFn = async function* (_messages, { signal }) {
      modelSignal = signal
      yield 'first'
      firstChunkSent.open()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      yield 'never shown'
    }
    const api = createSidecarApi(db, { streamFn })
    const res = await api(post('/tutor/stream', { ...lesson, message: 'Q' }))
    const reader = res.body!.getReader()
    await reader.read()
    await firstChunkSent.opened
    await reader.cancel()
    expect(modelSignal!.aborted).toBe(true)
    await Bun.sleep(5)
    expect((db.query('SELECT COUNT(*) AS c FROM sidecar_tutor_turns').get() as { c: number }).c).toBe(0)
  })

  test('the client disconnecting (request signal) aborts the model request', async () => {
    const db = openTemp()
    const started = gate()
    let modelSignal: AbortSignal | undefined
    const api = createSidecarApi(db, {
      streamFn: async function* (_messages, { signal }) {
        modelSignal = signal
        started.open()
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        yield 'never shown'
      },
    })
    const client = new AbortController()
    const res = await api(post('/tutor/stream', { ...lesson, message: 'Q' }, { signal: client.signal }))
    await started.opened
    client.abort()
    expect(modelSignal!.aborted).toBe(true)
    await res.text().catch(() => '')
    expect((db.query('SELECT COUNT(*) AS c FROM sidecar_tutor_turns').get() as { c: number }).c).toBe(0)
  })

  test('long conversations send only the capped history and say how many turns were left out', async () => {
    const db = openTemp()
    let sent: Message[] = []
    let n = 0
    const api = createSidecarApi(db, {
      now: () => ++n * 10,
      completeFn: async () => `answer ${n}`,
      streamFn: async function* (messages) {
        sent = messages
        yield 'ok'
      },
    })
    for (let i = 0; i < 8; i++) await api(post('/tutor', { ...lesson, message: `question ${i}` }))
    const events = await readEvents(await api(post('/tutor/stream', { ...lesson, message: 'latest' })))
    const context = events[0]!.data.context as { historyTurnsIncluded: number; historyTurnsDropped: number }
    expect(context).toMatchObject({ historyTurnsIncluded: TUTOR_HISTORY_LIMIT.maxTurns, historyTurnsDropped: 16 - TUTOR_HISTORY_LIMIT.maxTurns })
    // system, lesson context, capped history, new question
    expect(sent.length).toBe(2 + TUTOR_HISTORY_LIMIT.maxTurns + 1)
    expect(sent[2]).toEqual({ role: 'user', content: 'question 2' })
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'latest' })
  })
})

describe('provider streaming (completeStream)', () => {
  function fakeProvider(handler: (request: Request) => Response | Promise<Response>) {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler })
    const prev = { base: process.env.NORI_LLM_BASE_URL, model: process.env.NORI_LLM_MODEL }
    process.env.NORI_LLM_BASE_URL = `http://127.0.0.1:${server.port}/v1`
    process.env.NORI_LLM_MODEL = 'fake'
    cleanups.push(() => {
      server.stop(true)
      for (const [key, value] of [['NORI_LLM_BASE_URL', prev.base], ['NORI_LLM_MODEL', prev.model]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
  }

  const sse = (chunks: string[]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
          controller.close()
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )

  const messages: Message[] = [{ role: 'user', content: 'hi' }]

  test('parses OpenAI-style deltas split across network chunks', async () => {
    let body: Record<string, unknown> = {}
    fakeProvider(async (request) => {
      body = await request.json()
      return sse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"del',
        'ta":{"content":"lo"}}]}\r\n\r\n',
        'data: [DONE]\n\n',
      ])
    })
    const out: string[] = []
    for await (const delta of completeStream(messages)) out.push(delta)
    expect(out).toEqual(['Hel', 'lo'])
    expect(body.stream).toBe(true)
  })

  const collect = async () => {
    const out: string[] = []
    for await (const delta of completeStream(messages)) out.push(delta)
    return out
  }

  test('fails, rather than finishing, when the provider reports an error mid-reply', async () => {
    fakeProvider(() => sse(['data: {"choices":[{"delta":{"content":"Half"}}]}\n\n', 'data: {"error":{"message":"overloaded"}}\n\n']))
    await expect(collect()).rejects.toThrow(/error mid-reply/)
  })

  test('fails when the stream ends without [DONE] or a finish_reason', async () => {
    fakeProvider(() => sse(['data: {"choices":[{"delta":{"content":"Partial ans"}}]}\n\n']))
    await expect(collect()).rejects.toThrow(/cut off/)
  })

  test('reads a final line without its newline, and accepts finish_reason as the end', async () => {
    fakeProvider(() => sse(['data: {"choices":[{"delta":{"content":"A"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}']))
    expect(await collect()).toEqual(['A', 'B'])
  })

  test('falls back to reasoning text when no content arrives', async () => {
    fakeProvider(() => sse(['data: {"choices":[{"delta":{"reasoning_content":"thought"}}]}\n\n', 'data: [DONE]\n\n']))
    const out: string[] = []
    for await (const delta of completeStream(messages)) out.push(delta)
    expect(out).toEqual(['thought'])
  })

  test('aborting the signal cancels the provider request', async () => {
    const providerSawAbort = gate()
    fakeProvider((request) => {
      request.signal.addEventListener('abort', () => providerSawAbort.open())
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    })
    const controller = new AbortController()
    const out: string[] = []
    const run = (async () => {
      for await (const delta of completeStream(messages, { signal: controller.signal })) {
        out.push(delta)
        controller.abort()
      }
    })()
    await expect(run).rejects.toBeDefined()
    expect(out).toEqual(['a'])
    await providerSawAbort.opened
  })

  test('a provider that goes silent ends with a ModelError', async () => {
    fakeProvider(
      () =>
        new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } }),
    )
    const run = (async () => {
      for await (const _ of completeStream(messages, { idleTimeoutMs: 30 })) void _
    })()
    await expect(run).rejects.toThrow('stopped responding')
  })
})
