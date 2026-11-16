import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { openDatabase } from './database'

mkdirSync('.tmp/nori-modules', { recursive: true })
const directory = mkdtempSync(join('.tmp/nori-modules', 'migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const courseId = '11111111-1111-4111-8111-111111111111'
const moduleId = '22222222-2222-4222-8222-222222222222'
const exerciseIds = ['33333333-3333-4333-8333-333333333331', '33333333-3333-4333-8333-333333333332', '33333333-3333-4333-8333-333333333333']

function legacyContent() {
  return {
    title: 'Foundations', lessons: [{ title: 'One', body: 'Existing lesson body.' }],
    exercises: [
      { id: exerciseIds[0], type: 'multiple_choice', prompt: 'Pick', options: ['A', 'B'], answer: 'A', explanation: 'A is right' },
      { id: exerciseIds[1], type: 'written', prompt: 'Explain', options: [], answer: 'Reference', explanation: 'Reason' },
      { id: exerciseIds[2], type: 'code', prompt: 'Code', options: [], answer: 'Reference', explanation: 'Reason' },
    ],
  }
}

// The exact schema written by the one-module build at 7f3de85.
function createLegacyDatabase(path: string, options: { exerciseColumns: boolean }) {
  const database = new Database(path, { create: true })
  database.run('PRAGMA journal_mode = WAL')
  database.run('PRAGMA foreign_keys = ON')
  database.run(`CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`)
  database.run(`CREATE TABLE courses (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, created_at TEXT NOT NULL)`)
  database.run(`ALTER TABLE courses ADD COLUMN outline TEXT NOT NULL DEFAULT ''`)
  database.run(`ALTER TABLE courses ADD COLUMN outline_approved INTEGER NOT NULL DEFAULT 0`)
  database.run(`CREATE TABLE sources (id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, name TEXT NOT NULL, content BLOB NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)`)
  database.run(`CREATE TABLE modules (id TEXT PRIMARY KEY, course_id TEXT NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE, content TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0)`)
  database.run(options.exerciseColumns
    ? `CREATE TABLE attempts (id TEXT PRIMARY KEY, module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE, exercise_index INTEGER NOT NULL, answer TEXT NOT NULL, feedback TEXT NOT NULL, correct INTEGER, created_at INTEGER NOT NULL, owner_note TEXT NOT NULL DEFAULT '', exercise_id TEXT)`
    : `CREATE TABLE attempts (id TEXT PRIMARY KEY, module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE, exercise_index INTEGER NOT NULL, answer TEXT NOT NULL, feedback TEXT NOT NULL, correct INTEGER, created_at INTEGER NOT NULL)`)
  database.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user', 'assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL)`)
  database.run('INSERT INTO courses (id, title, goal, created_at, outline, outline_approved) VALUES (?, ?, ?, ?, ?, 1)', [courseId, 'Existing course', 'Keep this goal.', '2026-11-01T00:00:00.000Z', 'Module 1: Foundations'])
  database.run('INSERT INTO sources (id, course_id, name, content, text, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['44444444-4444-4444-8444-444444444444', courseId, 'notes.md', new Uint8Array([1, 2, 3]), 'Existing source text', 1])
  const content = legacyContent()
  if (!options.exerciseColumns) content.exercises.forEach((exercise) => { delete (exercise as { id?: string }).id })
  database.run('INSERT INTO modules (id, course_id, content, accepted) VALUES (?, ?, ?, 1)', [moduleId, courseId, JSON.stringify(content)])
  database.run('INSERT INTO attempts (id, module_id, exercise_index, answer, feedback, correct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['55555555-5555-4555-8555-555555555551', moduleId, 1, 'The core idea.', 'Consider an example.', null, 100])
  database.run('INSERT INTO attempts (id, module_id, exercise_index, answer, feedback, correct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['55555555-5555-4555-8555-555555555552', moduleId, 0, 'A', 'Correct. A is right', 1, 101])
  if (options.exerciseColumns) {
    database.run('UPDATE attempts SET exercise_id = ?, owner_note = ? WHERE id = ?', [exerciseIds[1], 'The answer is also valid.', '55555555-5555-4555-8555-555555555551'])
    database.run('UPDATE attempts SET exercise_id = ? WHERE id = ?', [exerciseIds[0], '55555555-5555-4555-8555-555555555552'])
  }
  database.close()
}

function uniqueIndexColumns(database: Database) {
  const indexes = database.query('PRAGMA index_list(modules)').all() as { name: string; unique: number }[]
  return indexes.filter((index) => index.unique).map((index) => (database.query(`PRAGMA index_info("${index.name}")`).all() as { name: string }[]).map((column) => column.name)).filter((names) => names.join(',') !== 'id')
}

describe('one-module database migration', () => {
  test('keeps course, module, exercise and attempt identity and is idempotent on restart', () => {
    const path = join(directory, 'legacy.sqlite')
    createLegacyDatabase(path, { exerciseColumns: true })
    const before = JSON.stringify(legacyContent())

    const database = openDatabase(path)
    const module = database.query('SELECT id, course_id, position, content, accepted, accepted_at, created_at FROM modules').get() as { id: string; course_id: string; position: number; content: string; accepted: number; accepted_at: number | null; created_at: number }
    expect(module).toEqual({ id: moduleId, course_id: courseId, position: 1, content: before, accepted: 1, accepted_at: null, created_at: 0 })
    expect(JSON.parse(module.content).exercises.map((exercise: { id: string }) => exercise.id)).toEqual(exerciseIds)
    expect(database.query('SELECT id, title, goal, outline, outline_approved FROM courses').get()).toEqual({ id: courseId, title: 'Existing course', goal: 'Keep this goal.', outline: 'Module 1: Foundations', outline_approved: 1 })
    expect(database.query('SELECT id, exercise_index, answer, feedback, correct, owner_note, exercise_id FROM attempts ORDER BY exercise_index').all()).toEqual([
      { id: '55555555-5555-4555-8555-555555555552', exercise_index: 0, answer: 'A', feedback: 'Correct. A is right', correct: 1, owner_note: '', exercise_id: exerciseIds[0] },
      { id: '55555555-5555-4555-8555-555555555551', exercise_index: 1, answer: 'The core idea.', feedback: 'Consider an example.', correct: null, owner_note: 'The answer is also valid.', exercise_id: exerciseIds[1] },
    ])
    expect(uniqueIndexColumns(database)).toEqual([['course_id', 'position']])
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect((database.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('assessments', 'assessment_items', 'assessment_answers', 'assessment_results') ORDER BY name").all()).toEqual([{ name: 'assessment_answers' }, { name: 'assessment_items' }, { name: 'assessment_results' }, { name: 'assessments' }])

    database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, ?, ?, 0, ?)', ['66666666-6666-4666-8666-666666666666', courseId, 2, before, Date.now()])
    expect(() => database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, ?, ?, 0, ?)', ['77777777-7777-4777-8777-777777777777', courseId, 2, before, Date.now()])).toThrow()
    database.close()

    const restarted = openDatabase(path)
    expect(restarted.query('SELECT COUNT(*) AS count FROM modules').get()).toEqual({ count: 2 })
    expect(restarted.query('SELECT position, content FROM modules WHERE id = ?').get(moduleId)).toEqual({ position: 1, content: before })
    expect(restarted.query('SELECT COUNT(*) AS count FROM attempts').get()).toEqual({ count: 2 })
    expect(uniqueIndexColumns(restarted)).toEqual([['course_id', 'position']])
    expect(restarted.query('PRAGMA foreign_key_check').all()).toEqual([])
    restarted.close()

    const reopened = openDatabase(path)
    expect(reopened.query('SELECT COUNT(*) AS count FROM modules').get()).toEqual({ count: 2 })
    expect(reopened.query('SELECT content FROM modules WHERE id = ?').get(moduleId)).toEqual({ content: before })
    reopened.close()
  })

  test('backfills exercise IDs and attempt links without rewriting existing text', () => {
    const path = join(directory, 'pre-exercise-ids.sqlite')
    createLegacyDatabase(path, { exerciseColumns: false })
    const database = openDatabase(path)
    const module = database.query('SELECT content FROM modules WHERE id = ?').get(moduleId) as { content: string }
    const content = JSON.parse(module.content) as { title: string; exercises: { id: string }[] }
    expect(content.title).toBe('Foundations')
    expect(content.exercises).toHaveLength(3)
    expect(content.exercises.every((exercise) => /^[0-9a-f-]{36}$/.test(exercise.id))).toBe(true)
    expect(new Set(content.exercises.map((exercise) => exercise.id)).size).toBe(3)
    const attempts = database.query('SELECT exercise_id, owner_note FROM attempts ORDER BY exercise_index').all() as { exercise_id: string; owner_note: string }[]
    expect(attempts.map((attempt) => attempt.exercise_id)).toEqual([content.exercises[0].id, content.exercises[1].id])
    expect(attempts.every((attempt) => attempt.owner_note === '')).toBe(true)
    const ids = content.exercises.map((exercise) => exercise.id)
    database.close()

    const restarted = openDatabase(path)
    const reopened = JSON.parse((restarted.query('SELECT content FROM modules WHERE id = ?').get(moduleId) as { content: string }).content) as { exercises: { id: string }[] }
    expect(reopened.exercises.map((exercise) => exercise.id)).toEqual(ids)
    restarted.close()
  })

  test('rolls back a failed rebuild and leaves the original table usable', () => {
    const path = join(directory, 'rollback.sqlite')
    const legacy = new Database(path, { create: true })
    legacy.run('PRAGMA foreign_keys = ON')
    legacy.run(`CREATE TABLE courses (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, created_at TEXT NOT NULL, outline TEXT NOT NULL DEFAULT '', outline_approved INTEGER NOT NULL DEFAULT 0)`)
    // A nullable position column plus the legacy unique course index forces the rebuild to fail mid-way.
    legacy.run(`CREATE TABLE modules (id TEXT PRIMARY KEY, course_id TEXT NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE, position INTEGER, content TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0)`)
    legacy.run(`CREATE TABLE attempts (id TEXT PRIMARY KEY, module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE, exercise_index INTEGER NOT NULL, answer TEXT NOT NULL, feedback TEXT NOT NULL, correct INTEGER, created_at INTEGER NOT NULL, owner_note TEXT NOT NULL DEFAULT '', exercise_id TEXT)`)
    legacy.run('INSERT INTO courses (id, title, goal, created_at) VALUES (?, ?, ?, ?)', [courseId, 'Rollback course', 'Keep data.', '2026-11-01T00:00:00.000Z'])
    legacy.run('INSERT INTO modules (id, course_id, position, content, accepted) VALUES (?, ?, NULL, ?, 0)', [moduleId, courseId, JSON.stringify(legacyContent())])
    legacy.run('INSERT INTO attempts (id, module_id, exercise_index, answer, feedback, correct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['55555555-5555-4555-8555-555555555551', moduleId, 0, 'A', 'Correct', 1, 100])
    legacy.close()

    expect(() => openDatabase(path)).toThrow()
    const raw = new Database(path)
    expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('modules', 'modules_new') ORDER BY name").all()).toEqual([{ name: 'modules' }])
    expect(raw.query('SELECT id, position FROM modules').all()).toEqual([{ id: moduleId, position: null }])
    expect(raw.query('SELECT COUNT(*) AS count FROM attempts').get()).toEqual({ count: 1 })
    expect(uniqueIndexColumns(raw)).toEqual([['course_id']])
    raw.close()
  })
})
