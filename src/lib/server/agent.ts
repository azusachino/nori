import { createHash } from 'node:crypto'
import { db } from './db'
import { readJson } from './input'
import { parseModule } from './module'

export async function agentApi(request: Request): Promise<Response> {
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
  const course = db.query('SELECT id, title, goal, outline, outline_approved FROM courses WHERE id = ?').get(id) as { outline: string; outline_approved: number } | null
  if (!course) return Response.json({ error: 'Not found' }, { status: 404 })
  if (request.method === 'GET' && !action) {
    const row = db.query('SELECT content FROM modules WHERE course_id = ? AND accepted = 0').get(id) as { content: string } | null
    const draft = row ? { content: JSON.parse(row.content) as unknown, contentHash: createHash('sha256').update(row.content).digest('hex') } : null
    return Response.json({ ...course, draft }, { headers: { 'Cache-Control': 'no-store' } })
  }
  if (request.method === 'POST' && action === 'outline') {
    if (course.outline_approved) return Response.json({ error: 'The owner has already approved this outline.' }, { status: 409 })
    const body = await readJson(request, 250000) as { outline?: unknown; expectedOutline?: unknown } | null
    if (typeof body?.outline !== 'string' || !body.outline.trim() || body.outline.length > 20000) return Response.json({ error: 'Invalid outline.' }, { status: 400 })
    if (course.outline && body.expectedOutline !== course.outline) return Response.json({ error: 'Outline changed. Read it again before revising.' }, { status: 409 })
    const result = db.run('UPDATE courses SET outline = ? WHERE id = ? AND outline_approved = 0 AND outline = ?', [body.outline.trim(), id, course.outline])
    if (!result.changes) return Response.json({ error: 'Outline changed. Read it again before revising.' }, { status: 409 })
    return Response.json({ ok: true })
  }
  if (request.method === 'POST' && action === 'module') {
    const existing = db.query('SELECT id, content, accepted FROM modules WHERE course_id = ?').get(id) as { id: string; content: string; accepted: number } | null
    if (!course.outline_approved || existing?.accepted) return Response.json({ error: 'The outline must be approved and the module must be a draft.' }, { status: 409 })
    try {
      const body = await readJson(request, 160000) as { content?: unknown; expectedContentHash?: unknown } | null
      const content = parseModule(JSON.stringify(body?.content))
      if (existing) {
        const currentHash = createHash('sha256').update(existing.content).digest('hex')
        if (body?.expectedContentHash !== currentHash) return Response.json({ error: 'Draft changed. Read it again before revising.' }, { status: 409 })
        const result = db.run('UPDATE modules SET content = ? WHERE id = ? AND content = ? AND accepted = 0', [JSON.stringify(content), existing.id, existing.content])
        if (!result.changes) return Response.json({ error: 'Draft changed. Read it again before revising.' }, { status: 409 })
        return Response.json({ ok: true })
      }
      db.run('INSERT INTO modules (id, course_id, content) VALUES (?, ?, ?)', [crypto.randomUUID(), id, JSON.stringify(content)])
      return Response.json({ ok: true }, { status: 201 })
    } catch { return Response.json({ error: 'Could not save module draft.' }, { status: 400 }) }
  }
  return Response.json({ error: 'Not found' }, { status: 404 })
}
