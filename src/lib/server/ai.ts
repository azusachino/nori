import { setting } from './config'

export type Message = { role: 'system' | 'user' | 'assistant'; content: string }

export class ModelError extends Error {}

export const CONTEXT_LIMIT = 120000
/** Longest reply accepted from the provider. */
export const REPLY_LIMIT = 40000
/** How long the provider may stay silent: for a whole reply, or between streamed chunks. */
export const PROVIDER_TIMEOUT_MS = 90000

export function withRecentHistory(prefix: Message[], history: Message[], suffix: Message[] = []): Message[] {
  let remaining = CONTEXT_LIMIT - [...prefix, ...suffix].reduce((total, message) => total + message.content.length, 0)
  let start = history.length
  while (start > 0 && history[start - 1].content.length <= remaining) {
    remaining -= history[--start].content.length
  }
  return [...prefix, ...history.slice(start), ...suffix]
}

function providerRequest(messages: Message[], body: Record<string, unknown>): { url: URL; init: RequestInit } {
  if (messages.reduce((total, message) => total + message.content.length, 0) > CONTEXT_LIMIT) throw new ModelError('The material is too long for one request. Remove a source or shorten the conversation or draft outline, then try again.')
  const base = setting('LLM_BASE_URL')
  const model = setting('LLM_MODEL')
  if (!base || !model) throw new ModelError('Set NORI_LLM_BASE_URL and NORI_LLM_MODEL to use the tutor.')
  let url: URL
  try { url = new URL(`${base.replace(/\/$/, '')}/chat/completions`) } catch { throw new ModelError('The model endpoint is not a valid URL.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ModelError('The model endpoint must use HTTP or HTTPS.')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = setting('LLM_API_KEY')
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return { url, init: { method: 'POST', headers, body: JSON.stringify({ model, messages, ...body }), redirect: 'error' } }
}

/** One blocking completion. `signal` cancels the provider request (e.g. when the client disconnects). */
export async function complete(messages: Message[], maxTokens = 4096, signal?: AbortSignal): Promise<string> {
  const { url, init } = providerRequest(messages, { max_tokens: maxTokens })
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  const response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!response.ok) throw new ModelError(`The model provider returned an error (${response.status}).`)
  const data = await response.json() as { choices?: { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string }[] }
  const choice = data.choices?.[0]
  if (choice?.finish_reason === 'length') throw new ModelError('The model reply was cut off at the token limit. Please retry with a shorter question.')
  const rawContent = typeof choice?.message?.content === 'string' && choice.message.content.trim()
    ? choice.message.content
    : typeof choice?.message?.reasoning_content === 'string'
      ? choice.message.reasoning_content
      : null
  if (!rawContent || !rawContent.trim() || rawContent.length > REPLY_LIMIT) throw new ModelError('The model returned an incomplete or invalid response. Please retry.')
  return rawContent.trim()
}

export type StreamOptions = { signal?: AbortSignal; maxTokens?: number; idleTimeoutMs?: number }

/**
 * A streamed completion (`stream: true`), yielding content deltas as the
 * provider sends them. Aborting `signal`, or stopping iteration early, cancels
 * the provider request. As in `complete`, a reply with no content falls back to
 * the reasoning text, yielded once at the end.
 */
export async function* completeStream(messages: Message[], options: StreamOptions = {}): AsyncGenerator<string> {
  const { url, init } = providerRequest(messages, { max_tokens: options.maxTokens ?? 4096, stream: true })
  const idleTimeoutMs = options.idleTimeoutMs ?? PROVIDER_TIMEOUT_MS
  const upstream = new AbortController()
  const cancel = () => upstream.abort()
  if (options.signal?.aborted) throw options.signal.reason
  options.signal?.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  let idle = setTimeout(() => { timedOut = true; upstream.abort() }, idleTimeoutMs)
  const touch = () => {
    clearTimeout(idle)
    idle = setTimeout(() => { timedOut = true; upstream.abort() }, idleTimeoutMs)
  }
  try {
    const response = await fetch(url, { ...init, signal: upstream.signal })
    if (!response.ok || !response.body) throw new ModelError(`The model provider returned an error (${response.status}).`)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let length = 0
    let reasoning = ''
    let finished = false
    let sawDone = false
    let truncated = false
    // One SSE line: the text it adds, or null. A stream is complete only on `[DONE]` or a
    // finish_reason; an in-band error or an early EOF is a failure, never a finished reply.
    // Keep reading until `[DONE]` or EOF even after `finish_reason` so trailing chunks are not lost.
    const readLine = (raw: string): string | null => {
      const line = raw.replace(/\r$/, '')
      if (!line.startsWith('data:')) return null
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') { finished = true; sawDone = true; return null }
      let chunk: { error?: unknown; choices?: { finish_reason?: unknown; delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[] }
      try { chunk = JSON.parse(payload) } catch { return null }
      if (chunk.error) throw new ModelError('The model provider reported an error mid-reply. Please retry.')
      const choice = chunk.choices?.[0]
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
        finished = true
        if (choice.finish_reason === 'length') truncated = true
      }
      const delta = choice?.delta
      if (typeof delta?.content === 'string' && delta.content) return delta.content
      const thought = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : typeof delta?.reasoning === 'string' ? delta.reasoning : ''
      if (thought && reasoning.length <= REPLY_LIMIT) reasoning += thought
      return null
    }
    let streamEnded = false
    while (!sawDone && !streamEnded) {
      const { done, value } = await reader.read()
      if (done) {
        // The last line may lack its newline.
        streamEnded = true
        buffer += '\n'
      } else {
        touch()
        buffer += value
      }
      let newline: number
      while (!sawDone && (newline = buffer.indexOf('\n')) >= 0) {
        const text = readLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (text === null) continue
        length += text.length
        if (length > REPLY_LIMIT) throw new ModelError('The model reply is too long. Ask a narrower question.')
        yield text
      }
    }
    if (truncated) throw new ModelError('The model reply was cut off at the token limit. Please retry with a shorter question.')
    if (!finished) throw new ModelError('The model reply was cut off. Please retry.')
    if (length === 0) {
      if (!reasoning.trim() || reasoning.length > REPLY_LIMIT) throw new ModelError('The model returned an incomplete or invalid response. Please retry.')
      yield reasoning
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    if (timedOut) throw new ModelError('The model provider stopped responding.')
    if (error instanceof ModelError) throw error
    throw new ModelError('Model provider request failed.')
  } finally {
    clearTimeout(idle)
    options.signal?.removeEventListener('abort', cancel)
    // Closes the provider connection when the consumer stops early.
    upstream.abort()
  }
}
