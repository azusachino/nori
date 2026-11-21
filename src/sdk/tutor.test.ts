import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelError } from '../lib/server/ai'
import { openDatabase } from '../lib/server/database'
import { createSidecarApi, type SidecarOptions } from '../lib/server/sidecar'
import { extractHeadings, renderRichText } from './components/markdown'
import { NoriApiError, NoriClient, type FetchFn } from './index'

const BASE_URL = 'http://127.0.0.1:3001/api/nori/v1'
const dirs: string[] = []
const clients: NoriClient[] = []

afterEach(() => {
  while (clients.length) clients.pop()!.dispose()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function sidecar(options: SidecarOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'nori-tutor-sdk-'))
  dirs.push(dir)
  const db = openDatabase(join(dir, 'nori.sqlite'))
  const api = createSidecarApi(db, options)
  const paths: string[] = []
  const fetchFn: FetchFn = (input, init) => {
    paths.push(new URL(String(input)).pathname)
    return api(new Request(String(input), init))
  }
  return { db, fetchFn, paths }
}

function makeClient(fetchFn: FetchFn) {
  const client = new NoriClient({ baseUrl: BASE_URL, fetchFn, retryBaseMs: 60_000 })
  clients.push(client)
  return client
}

const input = {
  courseKey: 'ai/cs229',
  lessonKey: '01-glms',
  lessonTitle: 'GLMs',
  lessonText: 'Exponential family notes.',
  message: 'Why is a(eta) convex?',
}

describe('NoriClient.streamTutorMessage', () => {
  test('reports the context and each delta, then resolves with the saved turns', async () => {
    const { fetchFn, paths } = sidecar({
      streamFn: async function* () {
        yield 'Because '
        yield 'its Hessian is a covariance.'
      },
    })
    const client = makeClient(fetchFn)
    const seen: string[] = []
    const res = await client.streamTutorMessage(input, {
      onStart: (context) => seen.push(`start:${context.historyTurnsIncluded}`),
      onDelta: (text) => seen.push(text),
    })
    expect(seen).toEqual(['start:0', 'Because ', 'its Hessian is a covariance.'])
    expect(res.turns.map((t) => t.content)).toEqual([input.message, 'Because its Hessian is a covariance.'])
    expect(paths.filter((p) => p.endsWith('/tutor'))).toEqual([])
    expect(client.connectionState).toBe('online')
  })

  test('falls back to the blocking call on a sidecar without the tutor-stream feature', async () => {
    const real = sidecar({ completeFn: async () => 'blocking reply' })
    // An older sidecar: no features in /health, and no /tutor/stream route.
    const fetchFn: FetchFn = async (url, init) => {
      if (String(url).endsWith('/tutor/stream')) return Response.json({ error: 'Not found' }, { status: 404 })
      const res = await real.fetchFn(url, init)
      if (!String(url).endsWith('/health')) return res
      const { features: _features, ...older } = await res.json()
      return Response.json(older)
    }
    const deltas: string[] = []
    const res = await makeClient(fetchFn).streamTutorMessage(input, { onDelta: (t) => deltas.push(t) })
    expect(res.turns.at(-1)!.content).toBe('blocking reply')
    expect(deltas).toEqual([])
    expect(real.paths).not.toContain('/api/nori/v1/tutor/stream')
  })

  test('cancel aborts the model request on the sidecar, saves nothing, and keeps the sidecar online', async () => {
    let modelSignal: AbortSignal | undefined
    let firstDelta!: () => void
    const deltaSeen = new Promise<void>((resolve) => (firstDelta = resolve))
    const { db, fetchFn } = sidecar({
      streamFn: async function* (_messages, { signal }) {
        modelSignal = signal
        yield 'partial'
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      },
    })
    const client = makeClient(fetchFn)
    const controller = new AbortController()
    const pending = client.streamTutorMessage(input, { onDelta: () => firstDelta() }, controller.signal)
    await deltaSeen
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    expect(modelSignal!.aborted).toBe(true)
    expect(client.connectionState).toBe('online')
    expect((db.query('SELECT COUNT(*) AS c FROM sidecar_tutor_turns').get() as { c: number }).c).toBe(0)
  })

  test('a provider failure and a validation error become NoriApiErrors', async () => {
    const { fetchFn } = sidecar({
      streamFn: async function* () {
        throw new ModelError('Provider timeout')
      },
    })
    const client = makeClient(fetchFn)
    const failed = await client.streamTutorMessage(input).catch((e) => e)
    expect(failed).toBeInstanceOf(NoriApiError)
    expect(failed.status).toBe(502)
    expect(failed.message).toBe('Provider timeout')

    const invalid = await client.streamTutorMessage({ ...input, message: ' ' }).catch((e) => e)
    expect(invalid).toBeInstanceOf(NoriApiError)
    expect(invalid.status).toBe(400)
  })
})

describe('tutor reply rendering', () => {
  const reply = ['## Setup', 'Some text.', '```md', '# not a heading', '```', '### Detail', '- a', '- b', '## Summary', 'Done.'].join('\n')

  test('the outline ids match the rendered headings and skip code fences', () => {
    const headings = extractHeadings(reply, 'r1')
    expect(headings).toEqual([
      { id: 'r1-0', level: 2, text: 'Setup' },
      { id: 'r1-1', level: 3, text: 'Detail' },
      { id: 'r1-2', level: 2, text: 'Summary' },
    ])
    const html = renderToStaticMarkup(createElement('div', null, renderRichText(reply, { headingIdPrefix: 'r1' })))
    for (const h of headings) expect(html).toContain(`id="${h.id}"`)
    expect(html).not.toContain('id="r1-3"')
    expect(renderToStaticMarkup(createElement('div', null, renderRichText(reply)))).not.toContain('id=')
  })

  test('a heading marker still streaming in renders instead of stalling', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderRichText('Intro\n# ')))
    expect(html).toContain('Intro')
  })
})
