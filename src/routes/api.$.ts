import { createFileRoute } from '@tanstack/react-router'
import { sameOrigin, validHost } from '../lib/server/auth'
import { db } from '../lib/server/db'
import { createAgentApi } from '../lib/server/agent'
import { createLearnerApi } from '../lib/server/api'

const learnerApi = createLearnerApi(db)
const agentApi = createAgentApi(db)

async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname
  if (!validHost(request)) return Response.json({ error: 'Invalid request host' }, { status: 403 })
  if (path.startsWith('/api/agent/')) {
    if (request.method !== 'GET' && (request.headers.get('x-nori-agent') !== '1' || (request.headers.has('origin') && !sameOrigin(request)))) return Response.json({ error: 'Invalid agent request' }, { status: 403 })
    return agentApi(request)
  }
  if (request.method !== 'GET' && !sameOrigin(request)) return Response.json({ error: 'Invalid request origin' }, { status: 403 })
  return learnerApi(request)
}

const pending = new Set<string>()
async function guarded(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname
  const match = request.method === 'POST' ? path.match(/^\/api\/(?:agent\/)?courses\/([0-9a-f-]{36})\/(chat|outline|modules?)$/) : null
  const key = match ? `${match[1]}:${match[2]}` : null
  if (key && pending.has(key)) return Response.json({ error: 'A request is already in progress. Please wait.' }, { status: 409 })
  if (key) pending.add(key)
  try { return await handle(request) } finally { if (key) pending.delete(key) }
}

export const Route = createFileRoute('/api/$')({
  server: { handlers: { GET: ({ request }) => guarded(request), POST: ({ request }) => guarded(request) } },
})
