import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { createAgentApi } from './agent'
import { createLearnerApi } from './api'
import { openDatabase } from './database'

mkdirSync('.tmp/nori-modules', { recursive: true })
const directory = mkdtempSync(join('.tmp/nori-modules', 'conflict-'))
const path = join(directory, 'conflict.sqlite')
const database = openDatabase(path)
const learner = createLearnerApi(database)
const agent = createAgentApi(database)
afterAll(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })

const base = 'http://localhost:3000'

type Exercise = { id: string; type: 'multiple_choice' | 'written' | 'code'; prompt: string; options: string[]; answer: string; explanation: string }
type Content = { title: string; lessons: { title: string; body: string }[]; exercises: Exercise[] }

function moduleContent(title: string, prefix: string): Content {
  return {
    title, lessons: [{ title: `${prefix} lesson`, body: 'Lesson body.' }],
    exercises: [
      { id: crypto.randomUUID(), type: 'multiple_choice', prompt: `${prefix} choose`, options: ['A', 'B'], answer: 'A', explanation: 'A is correct.' },
      { id: crypto.randomUUID(), type: 'written', prompt: `${prefix} explain`, options: [], answer: 'Reference', explanation: 'Explain.' },
      { id: crypto.randomUUID(), type: 'code', prompt: `${prefix} code`, options: [], answer: 'Reference', explanation: 'Code.' },
    ],
  }
}

function call(side: typeof learner, path: string, body?: unknown) {
  return side(new Request(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}

async function createApprovedCourse() {
  const created = await call(agent, '/api/agent/courses', { title: `Race ${crypto.randomUUID()}`, goal: 'Keep ordinals safe.' })
  expect(created.status).toBe(201)
  const id = ((await created.json()) as { id: string }).id
  const outline = '1. Foundations\n2. Practice'
  expect((await call(agent, `/api/agent/courses/${id}/outline`, { outline })).status).toBe(200)
  expect((await call(learner, `/api/courses/${id}/approve`, { expectedOutline: outline })).status).toBe(200)
  return id
}

function insertModule(courseId: string, position: number, accepted: number, content: Content) {
  const id = crypto.randomUUID()
  database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, courseId, position, JSON.stringify(content), accepted, Date.now()])
  return id
}

async function modulesHash(courseId: string): Promise<string> {
  const response = await call(agent, `/api/agent/courses/${courseId}`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { modulesHash: string }).modulesHash
}

function modelReturning(content: Content, during: () => void) {
  const original = globalThis.fetch
  process.env.NORI_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
  process.env.NORI_LLM_MODEL = 'conflict-test'
  globalThis.fetch = (async () => {
    during()
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })
  }) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
    delete process.env.NORI_LLM_BASE_URL
    delete process.env.NORI_LLM_MODEL
  }
}

describe('module generation conflicts', () => {
  test('modulesHash observes a draft becoming accepted and expectedModulesHash rejects the stale value', async () => {
    const courseId = await createApprovedCourse()
    insertModule(courseId, 1, 1, moduleContent('Module one', 'first'))
    const draft = insertModule(courseId, 2, 0, moduleContent('Module two', 'second'))
    const beforeAcceptance = await modulesHash(courseId)
    const detail = await call(learner, `/api/courses/${courseId}`)
    const draftHash = ((await detail.json()) as { modules: { id: string; contentHash: string }[] }).modules.find((module) => module.id === draft)!.contentHash

    expect((await call(learner, `/api/courses/${courseId}/accept`, { moduleId: draft, expectedContentHash: draftHash })).status).toBe(200)
    const afterAcceptance = await modulesHash(courseId)
    expect(afterAcceptance).not.toBe(beforeAcceptance)

    const staleCreate = await call(agent, `/api/agent/courses/${courseId}/modules`, { content: moduleContent('Module three', 'third'), expectedModulesHash: beforeAcceptance })
    expect(staleCreate.status).toBe(409)
    const currentCreate = await call(agent, `/api/agent/courses/${courseId}/modules`, { content: moduleContent('Module three', 'third'), expectedModulesHash: afterAcceptance })
    expect(currentCreate.status).toBe(201)
    expect(((await currentCreate.json()) as { module: { position: number } }).module.position).toBe(3)
  })

  test('learner next-module generation rejects material prompted before a concurrent module was created and accepted', async () => {
    const courseId = await createApprovedCourse()
    insertModule(courseId, 1, 1, moduleContent('Module one', 'first'))
    const generated = moduleContent('Generated for ordinal two', 'generated')
    let raced = false
    const restore = modelReturning(generated, () => {
      raced = true
      insertModule(courseId, 2, 1, moduleContent('Concurrent module', 'concurrent'))
    })
    try {
      const response = await call(learner, `/api/courses/${courseId}/modules`, {})
      expect(response.status).toBe(409)
      expect(((await response.json()) as { error: string }).error).toContain('changed while generating')
    } finally { restore() }
    expect(raced).toBe(true)
    const modules = database.query('SELECT position, content FROM modules WHERE course_id = ? ORDER BY position').all(courseId) as { position: number; content: string }[]
    expect(modules.map((module) => module.position)).toEqual([1, 2])
    expect(JSON.parse(modules[1]!.content).title).toBe('Concurrent module')
    expect(modules.some((module) => JSON.parse(module.content).title === generated.title)).toBe(false)
  })

  test('legacy first-module generation still returns a conflict when another module appears during the model call', async () => {
    const courseId = await createApprovedCourse()
    const generated = moduleContent('Generated first module', 'generated')
    const raced = moduleContent('Concurrent first module', 'concurrent')
    const restore = modelReturning(generated, () => { insertModule(courseId, 1, 1, raced) })
    try {
      const response = await call(learner, `/api/courses/${courseId}/module`, {})
      expect(response.status).toBe(409)
      expect(((await response.json()) as { error: string }).error).toBe('Your first module already exists.')
    } finally { restore() }
    const modules = database.query('SELECT position, content FROM modules WHERE course_id = ? ORDER BY position').all(courseId) as { position: number; content: string }[]
    expect(modules).toHaveLength(1)
    expect(JSON.parse(modules[0]!.content).title).toBe('Concurrent first module')
  })
})
