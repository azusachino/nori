import { createHash, timingSafeEqual } from 'node:crypto'
import { db } from './db'
import { readJson } from './input'
import { parseModule } from './module'

function authorized(request: Request): boolean {
  const match = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)
  const expected = process.env.SAME_AGENT_TOKEN_HASH
  if (!match || !expected || !/^[a-f0-9]{64}$/.test(expected)) return false
  const actual = createHash('sha256').update(match[1]!).digest()
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'))
}

export async function agentApi(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const path = new URL(request.url).pathname
  if (request.method === 'POST' && path === '/api/agent/courses') {
    const body = await readJson(request) as { title?: unknown; goal?: unknown } | null
    if (typeof body?.title !== 'string' || !body.title.trim() || body.title.length > 160 || typeof body.goal !== 'string' || !body.goal.trim() || body.goal.length > 4000) return Response.json({ error: 'Invalid course title or goal.' }, { status: 400 })
    const course = { id: crypto.randomUUID(), title: body.title.trim(), goal: body.goal.trim(), created_at: new Date().toISOString() }
    db.run('INSERT INTO courses (id, title, goal, created_at) VALUES (?, ?, ?, ?)', [course.id, course.title, course.goal, course.created_at])
    return Response.json(course, { status: 201 })
  }
  const match = path.match(/^\/api\/agent\/courses\/([0-9a-f-]{36})(?:\/(outline|module))?$/)
  if (!match) return Response.json({ error: 'Not found' }, { status: 404 })
  const [, id, action] = match
  const course = db.query('SELECT id, title, goal, outline, outline_approved FROM courses WHERE id = ?').get(id) as { outline_approved: number } | null
  if (!course) return Response.json({ error: 'Not found' }, { status: 404 })
  if (request.method === 'GET' && !action) return Response.json(course, { headers: { 'Cache-Control': 'no-store' } })
  if (request.method === 'POST' && action === 'outline') {
    if (course.outline_approved) return Response.json({ error: 'The owner has already approved this outline.' }, { status: 409 })
    const body = await readJson(request) as { outline?: unknown } | null
    if (typeof body?.outline !== 'string' || !body.outline.trim() || body.outline.length > 20000) return Response.json({ error: 'Invalid outline.' }, { status: 400 })
    db.run('UPDATE courses SET outline = ? WHERE id = ? AND outline_approved = 0', [body.outline.trim(), id])
    return Response.json({ ok: true })
  }
  if (request.method === 'POST' && action === 'module') {
    const existing = db.query('SELECT accepted FROM modules WHERE course_id = ?').get(id) as { accepted: number } | null
    if (!course.outline_approved || existing) return Response.json({ error: 'The outline must be approved and the course must not already have a module.' }, { status: 409 })
    try {
      const body = await readJson(request, 160000) as { content?: unknown } | null
      const content = parseModule(JSON.stringify(body?.content))
      db.run('INSERT INTO modules (id, course_id, content) VALUES (?, ?, ?)', [crypto.randomUUID(), id, JSON.stringify(content)])
      return Response.json({ ok: true }, { status: 201 })
    } catch { return Response.json({ error: 'Invalid module.' }, { status: 400 }) }
  }
  return Response.json({ error: 'Not found' }, { status: 404 })
}
