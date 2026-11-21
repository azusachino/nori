export async function readJson(request: Request, limit = 32768): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null
  const length = Number(request.headers.get('content-length') || 0)
  if (length > limit || !request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) { await reader.cancel(); return null }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch { return null }
}

/**
 * The `view` query parameter of list endpoints: `full` (default, the v1 shape)
 * or `summary` (only what the SDK islands render). Returns null when invalid.
 */
export function parseListView(url: URL): 'full' | 'summary' | null {
  const view = url.searchParams.get('view')
  if (view === null || view === '' || view === 'full') return 'full'
  return view === 'summary' ? 'summary' : null
}

export const INVALID_VIEW_ERROR = 'view must be "full" or "summary".'
