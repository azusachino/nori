type Message = { role: 'system' | 'user' | 'assistant'; content: string }

export class ModelError extends Error {}

export async function complete(messages: Message[], maxTokens = 2000): Promise<string> {
  if (messages.reduce((total, message) => total + message.content.length, 0) > 120000) throw new ModelError('The material is too long for one request. Use shorter source documents or conversation messages.')
  const base = process.env.SAME_LLM_BASE_URL
  const model = process.env.SAME_LLM_MODEL
  if (!base || !model) throw new ModelError('Set SAME_LLM_BASE_URL and SAME_LLM_MODEL to use the tutor.')
  let url: URL
  try { url = new URL(`${base.replace(/\/$/, '')}/chat/completions`) } catch { throw new ModelError('The model endpoint is not a valid URL.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ModelError('The model endpoint must use HTTP or HTTPS.')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (process.env.SAME_LLM_API_KEY) headers.Authorization = `Bearer ${process.env.SAME_LLM_API_KEY}`
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model, messages, max_tokens: maxTokens }), redirect: 'error', signal: AbortSignal.timeout(90000) })
  if (!response.ok) throw new ModelError(`The model provider returned an error (${response.status}).`)
  const data = await response.json() as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] }
  const choice = data.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string' || !content.trim() || content.length > 40000 || choice?.finish_reason === 'length') throw new ModelError('The model returned an incomplete or invalid response. Please retry.')
  return content.trim()
}
