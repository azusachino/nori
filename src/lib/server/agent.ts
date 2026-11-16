import type { Database } from 'bun:sqlite'
import { readJson } from './input'
import { parseModule } from './module'
import { agentModule, firstModuleRow, hashContent, listModuleRows, moduleRowById, modulesHash, nextPosition } from './modules'

export function createAgentApi(database: Database) {
  return async function agentApi(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path === '/api/agent/courses') {
      const body = await readJson(request) as { title?: unknown; goal?: unknown } | null
      if (typeof body?.title !== 'string' || !body.title.trim() || body.title.length > 160 || typeof body.goal !== 'string' || !body.goal.trim() || body.goal.length > 4000) return Response.json({ error: 'Invalid course title or goal.' }, { status: 400 })
      const course = { id: crypto.randomUUID(), title: body.title.trim(), goal: body.goal.trim(), created_at: new Date().toISOString() }
      database.run('INSERT INTO courses (id, title, goal, created_at) VALUES (?, ?, ?, ?)', [course.id, course.title, course.goal, course.created_at])
      return Response.json(course, { status: 201 })
    }
    const match = path.match(/^\/api\/agent\/courses\/([0-9a-f-]{36})(?:\/(outline|modules|module))?$/)
    if (!match) return Response.json({ error: 'Not found' }, { status: 404 })
    const [, id, action] = match
    const course = database.query('SELECT id, title, goal, outline, outline_approved FROM courses WHERE id = ?').get(id) as { outline: string; outline_approved: number } | null
    if (!course) return Response.json({ error: 'Not found' }, { status: 404 })
    const rows = () => listModuleRows(database, id)
    const hash = () => modulesHash(rows())
    if (request.method === 'GET' && !action) {
      const modules = rows()
      const draftRow = modules.find((row) => !row.accepted) ?? null
      const draft = draftRow ? { id: draftRow.id, position: draftRow.position, content: JSON.parse(draftRow.content) as unknown, contentHash: hashContent(draftRow.content) } : null
      return Response.json({ ...course, modules: modules.map(agentModule), modulesHash: hash(), draft }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (request.method === 'POST' && action === 'outline') {
      if (course.outline_approved) return Response.json({ error: 'The owner has already approved this outline.' }, { status: 409 })
      const body = await readJson(request, 250000) as { outline?: unknown; expectedOutline?: unknown } | null
      if (typeof body?.outline !== 'string' || !body.outline.trim() || body.outline.length > 20000) return Response.json({ error: 'Invalid outline.' }, { status: 400 })
      if (course.outline && body.expectedOutline !== course.outline) return Response.json({ error: 'Outline changed. Read it again before revising.' }, { status: 409 })
      const result = database.run('UPDATE courses SET outline = ? WHERE id = ? AND outline_approved = 0 AND outline = ?', [body.outline.trim(), id, course.outline])
      if (!result.changes) return Response.json({ error: 'Outline changed. Read it again before revising.' }, { status: 409 })
      return Response.json({ ok: true })
    }
    if (request.method === 'GET' && action === 'modules') {
      return Response.json({ modules: rows().map(agentModule), modulesHash: hash() }, { headers: { 'Cache-Control': 'no-store' } })
    }
    // Legacy singular route: first module only, so old agent clients never retarget a later module.
    if (request.method === 'POST' && action === 'module') {
      const existing = firstModuleRow(database, id)
      if (!course.outline_approved || (rows().length && existing?.accepted)) return Response.json({ error: 'The outline must be approved and the module must be a draft.' }, { status: 409 })
      try {
        const body = await readJson(request, 160000) as { content?: unknown; expectedContentHash?: unknown } | null
        const content = parseModule(JSON.stringify(body?.content))
        if (existing) {
          if (body?.expectedContentHash !== hashContent(existing.content)) return Response.json({ error: 'Draft changed. Read it again before revising.' }, { status: 409 })
          const result = database.run('UPDATE modules SET content = ? WHERE id = ? AND content = ? AND accepted = 0', [JSON.stringify(content), existing.id, existing.content])
          if (!result.changes) return Response.json({ error: 'Draft changed. Read it again before revising.' }, { status: 409 })
          return Response.json({ ok: true })
        }
        database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, ?, ?, 0, ?)', [crypto.randomUUID(), id, 1, JSON.stringify(content), Date.now()])
        return Response.json({ ok: true }, { status: 201 })
      } catch { return Response.json({ error: 'Could not save module draft.' }, { status: 400 }) }
    }
    if (request.method === 'POST' && action === 'modules') {
      if (!course.outline_approved) return Response.json({ error: 'The outline must be approved before adding a module.' }, { status: 409 })
      try {
        const body = await readJson(request, 160000) as { content?: unknown; moduleId?: unknown; expectedContentHash?: unknown; expectedModulesHash?: unknown } | null
        if (body?.expectedModulesHash !== undefined && body.expectedModulesHash !== hash()) return Response.json({ error: 'Course modules changed. Read them again before revising.' }, { status: 409 })
        if (body?.moduleId !== undefined) {
          if (typeof body.moduleId !== 'string') return Response.json({ error: 'Invalid module.' }, { status: 400 })
          const existing = moduleRowById(database, id, body.moduleId)
          if (!existing) return Response.json({ error: 'Module not found.' }, { status: 404 })
          if (existing.accepted) return Response.json({ error: 'Accepted modules cannot be revised.' }, { status: 409 })
          const content = parseModule(JSON.stringify(body.content))
          if (body.expectedContentHash !== hashContent(existing.content)) return Response.json({ error: 'Draft changed. Read it again before revising.' }, { status: 409 })
          const result = database.run('UPDATE modules SET content = ? WHERE id = ? AND content = ? AND accepted = 0', [JSON.stringify(content), existing.id, existing.content])
          if (!result.changes) return Response.json({ error: 'Draft changed. Read it again before revising.' }, { status: 409 })
          return Response.json({ module: agentModule({ ...existing, content: JSON.stringify(content) }), modulesHash: hash() })
        }
        const current = rows()
        const latest = current.at(-1)
        if (latest && !latest.accepted) return Response.json({ error: 'Accept the current module before adding another.' }, { status: 409 })
        const content = parseModule(JSON.stringify(body?.content))
        database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, ?, ?, 0, ?)', [crypto.randomUUID(), id, nextPosition(current), JSON.stringify(content), Date.now()])
        const created = rows().at(-1)!
        return Response.json({ module: agentModule(created), modulesHash: hash() }, { status: 201 })
      } catch { return Response.json({ error: 'Could not save module draft.' }, { status: 400 }) }
    }
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
}
