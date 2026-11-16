import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { createAgentApi } from './agent'
import { createLearnerApi } from './api'
import { openDatabase } from './database'
import { hashContent } from './modules'

const directory = mkdtempSync(join('.tmp/nori-modules', 'api-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const path = join(directory, 'api.sqlite')
const database = openDatabase(path)
const learner = createLearnerApi(database)
const agent = createAgentApi(database)

const base = 'http://localhost:3000'

function moduleContent(title: string, prefix: string) {
  return {
    title, lessons: [{ title: `${prefix} lesson`, body: 'Lesson body.' }],
    exercises: [
      { id: crypto.randomUUID(), type: 'multiple_choice', prompt: `${prefix} choose`, options: ['A', 'B'], answer: 'A', explanation: 'A is correct.' },
      { id: crypto.randomUUID(), type: 'written', prompt: `${prefix} explain`, options: [], answer: 'Reference', explanation: 'Explain.' },
      { id: crypto.randomUUID(), type: 'code', prompt: `${prefix} code`, options: [], answer: 'Reference', explanation: 'Code.' },
    ],
  }
}

async function call(path: string, options: { method?: string; body?: unknown; agent?: boolean } = {}) {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.agent) headers['X-Nori-Agent'] = '1'
  return (options.agent ? agent : learner)(new Request(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }))
}

type Visible = { id: string; position: number; accepted: number; contentHash: string; title: string; attempts: { id: string; exercise_id: string | null }[]; exercises: { id: string; type: string }[] }
type CourseDetail = { module: Visible | null; modules: Visible[]; modulesHash: string }
type AgentDetail = { modules: { id: string; position: number; accepted: number; contentHash: string; content?: { title: string } }[]; modulesHash: string; draft: { id: string; position: number; contentHash: string; content: { title: string } } | null }

async function detail(id: string): Promise<CourseDetail> {
  const response = await call(`/api/courses/${id}`)
  expect(response.status).toBe(200)
  return response.json() as Promise<CourseDetail>
}

async function agentDetail(id: string): Promise<AgentDetail> {
  const response = await call(`/api/agent/courses/${id}`, { agent: true })
  expect(response.status).toBe(200)
  return response.json() as Promise<AgentDetail>
}

function insertModule(courseId: string, position: number, accepted: number, content: unknown) {
  const id = crypto.randomUUID()
  database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, courseId, position, JSON.stringify(content), accepted, Date.now()])
  return id
}

describe('ordered modules API', () => {
  test('legacy single-module calls keep targeting module one while later modules use explicit IDs', async () => {
    const created = await call('/api/agent/courses', { agent: true, body: { title: 'Ordered course', goal: 'Continue safely.' } })
    expect(created.status).toBe(201)
    const courseId = ((await created.json()) as { id: string }).id
    const outline = '1. Foundations\n2. Practice'
    expect((await call(`/api/agent/courses/${courseId}/outline`, { agent: true, body: { outline } })).status).toBe(200)
    expect((await call(`/api/courses/${courseId}/approve`, { body: { expectedOutline: outline } })).status).toBe(200)

    const first = insertModule(courseId, 1, 0, moduleContent('Module one', 'first'))
    let current = await detail(courseId)
    expect(current.module?.id).toBe(first)
    expect(current.module?.position).toBe(1)
    expect(current.modules).toHaveLength(1)
    expect(typeof current.modulesHash).toBe('string')

    // The legacy generate route stays first-module-only, and never asks the model when module one exists.
    expect((await call(`/api/courses/${courseId}/module`, { body: {} })).status).toBe(409)

    const edited = moduleContent('Module one edited', 'first')
    const saved = await call(`/api/courses/${courseId}/save-module`, { body: { content: edited, expectedContentHash: current.module!.contentHash } })
    expect(saved.status).toBe(200)
    const savedModule = ((await saved.json()) as { module: Visible }).module
    expect(savedModule.position).toBe(1)
    expect(savedModule.title).toBe('Module one edited')
    expect(savedModule.contentHash).not.toBe(current.module!.contentHash)
    expect((await call(`/api/courses/${courseId}/accept`, { body: { expectedContentHash: savedModule.contentHash } })).status).toBe(200)
    current = await detail(courseId)
    expect(current.module?.accepted).toBe(1)
    const firstAcceptedHash = current.module!.contentHash

    const second = insertModule(courseId, 2, 0, moduleContent('Module two', 'second'))
    current = await detail(courseId)
    expect(current.modules.map((module) => module.position)).toEqual([1, 2])
    expect(current.module?.id).toBe(first)
    expect(current.modules[1]!.id).toBe(second)

    // A pending draft blocks the next module, and later drafts are edited by explicit ID.
    expect((await call(`/api/courses/${courseId}/modules`, { body: {} })).status).toBe(409)
    const secondContent = moduleContent('Module two edited', 'second')
    const secondSaved = await call(`/api/courses/${courseId}/save-module`, { body: { moduleId: second, content: secondContent, expectedContentHash: current.modules[1]!.contentHash } })
    expect(secondSaved.status).toBe(200)
    const secondHash = ((await secondSaved.json()) as { module: Visible }).module.contentHash
    expect((await call(`/api/courses/${courseId}/accept`, { body: { moduleId: second, expectedContentHash: secondHash } })).status).toBe(200)
    current = await detail(courseId)
    expect(current.modules[0]!.contentHash).toBe(firstAcceptedHash)
    expect(current.modules[0]!.title).toBe('Module one edited')
    expect(current.modules[1]!.accepted).toBe(1)

    // Critical safety check: a legacy answer/correction after module two exists still targets module one.
    expect((await call(`/api/courses/${courseId}/answer`, { body: { index: 0, answer: 'A' } })).status).toBe(200)
    current = await detail(courseId)
    expect(current.modules[0]!.attempts).toHaveLength(1)
    expect(current.modules[1]!.attempts).toHaveLength(0)
    const firstAttempt = current.modules[0]!.attempts[0]!
    expect((await call(`/api/courses/${courseId}/answer`, { body: { moduleId: second, index: 0, answer: 'A' } })).status).toBe(200)
    current = await detail(courseId)
    expect(current.modules[1]!.attempts).toHaveLength(1)
    const secondAttempt = current.modules[1]!.attempts[0]!

    expect((await call(`/api/courses/${courseId}/feedback`, { body: { attemptId: secondAttempt.id, note: 'Wrong target' } })).status).toBe(404)
    expect((await call(`/api/courses/${courseId}/feedback`, { body: { moduleId: second, attemptId: secondAttempt.id, note: 'Correct target' } })).status).toBe(200)
    expect((await call(`/api/courses/${courseId}/feedback`, { body: { attemptId: firstAttempt.id, note: 'Legacy correction' } })).status).toBe(200)

    const third = insertModule(courseId, 3, 0, moduleContent('Module three', 'third'))
    expect((await call(`/api/courses/${courseId}/answer`, { body: { moduleId: third, index: 0, answer: 'A' } })).status).toBe(409)
    expect((await call(`/api/courses/${courseId}/save-module`, { body: { moduleId: first, content: edited, expectedContentHash: firstAcceptedHash } })).status).toBe(409)
    expect((await call(`/api/courses/${courseId}/accept`, { body: { moduleId: first, expectedContentHash: firstAcceptedHash } })).status).toBe(409)

    const detailAgent = await agentDetail(courseId)
    expect(detailAgent.modules.map((module) => module.position)).toEqual([1, 2, 3])
    expect(detailAgent.modules[0]!.content).toBeUndefined()
    expect(detailAgent.modules[1]!.content).toBeUndefined()
    expect(detailAgent.modules[2]!.content?.title).toBe('Module three')
    expect(detailAgent.draft?.id).toBe(third)
    expect(detailAgent.draft?.position).toBe(3)
    const listed = await call(`/api/agent/courses/${courseId}/modules`, { agent: true })
    expect(listed.status).toBe(200)
    expect(((await listed.json()) as { modules: unknown[] }).modules).toHaveLength(3)

    // Agent stale revisions conflict, current ones apply, and accepted modules stay immutable.
    const staleRevision = await call(`/api/agent/courses/${courseId}/modules`, { agent: true, body: { moduleId: third, content: moduleContent('Module three revised', 'third'), expectedContentHash: 'stale' } })
    expect(staleRevision.status).toBe(409)
    const thirdRevision = await call(`/api/agent/courses/${courseId}/modules`, { agent: true, body: { moduleId: third, content: moduleContent('Module three revised', 'third'), expectedContentHash: detailAgent.draft!.contentHash } })
    expect(thirdRevision.status).toBe(200)
    const revisedHash = ((await thirdRevision.json()) as { module: { contentHash: string } }).module.contentHash
    expect((await call(`/api/agent/courses/${courseId}/modules`, { agent: true, body: { moduleId: third, content: moduleContent('Another', 'third'), expectedContentHash: detailAgent.draft!.contentHash } })).status).toBe(409)
    expect((await call(`/api/agent/courses/${courseId}/modules`, { agent: true, body: { moduleId: third, content: moduleContent('Module three revised', 'third'), expectedContentHash: revisedHash, expectedModulesHash: 'stale' } })).status).toBe(409)
    expect((await call(`/api/agent/courses/${courseId}/modules`, { agent: true, body: { moduleId: first, content: moduleContent('Rewrite accepted', 'first'), expectedContentHash: firstAcceptedHash } })).status).toBe(409)
    expect((await call(`/api/agent/courses/${courseId}/modules`, { agent: true, body: { content: moduleContent('Blocked', 'fourth') } })).status).toBe(409)

    expect((await call(`/api/courses/${courseId}/accept`, { body: { moduleId: third, expectedContentHash: revisedHash } })).status).toBe(200)
    const createdNext = await call(`/api/agent/courses/${courseId}/modules`, { agent: true, body: { content: moduleContent('Module four', 'fourth') } })
    expect(createdNext.status).toBe(201)
    const fourth = ((await createdNext.json()) as { module: { id: string; position: number; contentHash: string } }).module
    expect(fourth.position).toBe(4)
    expect((await call(`/api/agent/courses/${courseId}/modules`, { agent: true, body: { moduleId: fourth.id, content: moduleContent('Module four revised', 'fourth'), expectedContentHash: fourth.contentHash } })).status).toBe(200)
    expect((await call(`/api/courses/${courseId}/module`, { body: {} })).status).toBe(409)
    expect((await call(`/api/agent/courses/${courseId}/module`, { agent: true, body: { content: moduleContent('Legacy rewrite', 'first') } })).status).toBe(409)

    current = await detail(courseId)
    expect(current.modules.map((module) => module.position)).toEqual([1, 2, 3, 4])
    expect(current.modules[0]!.title).toBe('Module one edited')
    expect(current.modules[0]!.contentHash).toBe(firstAcceptedHash)
    expect(current.modules[1]!.title).toBe('Module two edited')
    expect(current.modules[2]!.accepted).toBe(1)
    expect(current.modules[3]!.accepted).toBe(0)

    // Idempotent restart over populated data keeps every module, position and attempt.
    const attempts = database.query('SELECT COUNT(*) AS count FROM attempts').get()
    database.close()
    const reopened = openDatabase(path)
    expect(reopened.query('SELECT COUNT(*) AS count FROM modules').get()).toEqual({ count: 4 })
    expect(reopened.query('SELECT position FROM modules ORDER BY position').all()).toEqual([{ position: 1 }, { position: 2 }, { position: 3 }, { position: 4 }])
    expect(reopened.query('SELECT COUNT(*) AS count FROM attempts').get()).toEqual(attempts)
    const stored = reopened.query('SELECT content FROM modules WHERE id = ?').get(first) as { content: string }
    expect(hashContent(stored.content)).toBe(firstAcceptedHash)
    expect(reopened.query('PRAGMA foreign_key_check').all()).toEqual([])
    reopened.close()
  })
})
