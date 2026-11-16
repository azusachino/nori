import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { Module } from './module'

export type ModuleRow = { id: string; course_id: string; position: number; content: string; accepted: number; accepted_at: number | null; created_at: number }
export type AttemptRow = { id: string; exercise_id: string | null; exercise_index: number; answer: string; feedback: string; correct: number | null; owner_note: string }
export type VisibleExercise = { id: string; type: Module['exercises'][number]['type']; prompt: string; options: string[]; answer?: string; explanation?: string }
export type VisibleModule = { id: string; position: number; accepted: number; acceptedAt: number | null; contentHash: string; title: string; lessons: Module['lessons']; exercises: VisibleExercise[]; attempts: AttemptRow[] }
export type AgentModule = { id: string; position: number; accepted: number; acceptedAt: number | null; contentHash: string; content?: Module }

const columns = 'id, course_id, position, content, accepted, accepted_at, created_at'

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function listModuleRows(database: Database, courseId: string): ModuleRow[] {
  return database.query(`SELECT ${columns} FROM modules WHERE course_id = ? ORDER BY position`).all(courseId) as ModuleRow[]
}

export function firstModuleRow(database: Database, courseId: string): ModuleRow | null {
  return database.query(`SELECT ${columns} FROM modules WHERE course_id = ? ORDER BY position LIMIT 1`).get(courseId) as ModuleRow | null
}

export function moduleRowById(database: Database, courseId: string, moduleId: string): ModuleRow | null {
  return database.query(`SELECT ${columns} FROM modules WHERE course_id = ? AND id = ?`).get(courseId, moduleId) as ModuleRow | null
}

export function moduleAttempts(database: Database, moduleId: string): AttemptRow[] {
  return database.query('SELECT id, exercise_id, exercise_index, answer, feedback, correct, owner_note FROM attempts WHERE module_id = ? ORDER BY rowid').all(moduleId) as AttemptRow[]
}

export function visibleModule(database: Database, row: ModuleRow): VisibleModule {
  const content = JSON.parse(row.content) as Module
  const exercises = row.accepted
    ? content.exercises.map(({ id, type, prompt, options }) => ({ id, type, prompt, options }))
    : content.exercises
  return { id: row.id, position: row.position, accepted: row.accepted, acceptedAt: row.accepted_at, contentHash: hashContent(row.content), title: content.title, lessons: content.lessons, exercises, attempts: moduleAttempts(database, row.id) }
}

export function visibleModules(database: Database, courseId: string): VisibleModule[] {
  return listModuleRows(database, courseId).map((row) => visibleModule(database, row))
}

export function modulesHash(rows: ModuleRow[]): string {
  return hashContent(JSON.stringify(rows.map((row) => ({ id: row.id, position: row.position, contentHash: hashContent(row.content) }))))
}

export function nextPosition(rows: ModuleRow[]): number {
  return rows.length ? Math.max(...rows.map((row) => row.position)) + 1 : 1
}

// The agent sees complete content only for the draft it may revise; accepted modules stay metadata-only.
export function agentModule(row: ModuleRow): AgentModule {
  const module = { id: row.id, position: row.position, accepted: row.accepted, acceptedAt: row.accepted_at, contentHash: hashContent(row.content) }
  return row.accepted ? module : { ...module, content: JSON.parse(row.content) as Module }
}
