type Message = { role: 'system' | 'user' | 'assistant'; content: string }

export async function complete(messages: Message[]): Promise<string> {
  const base = process.env.SAME_LLM_BASE_URL
  const model = process.env.SAME_LLM_MODEL
  if (!base || !model) throw new Error('Set SAME_LLM_BASE_URL and SAME_LLM_MODEL to use the tutor.')
  let url: URL
  try { url = new URL(`${base.replace(/\/$/, '')}/chat/completions`) } catch { throw new Error('The model endpoint is not a valid URL.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The model endpoint must use HTTP or HTTPS.')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (process.env.SAME_LLM_API_KEY) headers.Authorization = `Bearer ${process.env.SAME_LLM_API_KEY}`
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model, messages, max_tokens: 2000 }), redirect: 'error', signal: AbortSignal.timeout(90000) })
  if (!response.ok) throw new Error(`The model provider returned an error (${response.status}).`)
  const data = await response.json() as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] }
  const choice = data.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string' || !content.trim() || content.length > 40000 || choice?.finish_reason === 'length') throw new Error('The model returned an incomplete or invalid response. Please retry.')
  return content.trim()
}
