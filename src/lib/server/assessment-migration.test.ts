import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { openDatabase } from './database'

mkdirSync('.tmp/nori-modules', { recursive: true })
const directory = mkdtempSync(join('.tmp/nori-modules', 'assessment-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const courseId = '11111111-1111-4111-8111-111111111111'
const firstModuleId = '22222222-2222-4222-8222-222222222221'
const secondModuleId = '22222222-2222-4222-8222-222222222222'
const assessmentId = '33333333-3333-4333-8333-333333333333'
const firstItemId = '44444444-4444-4444-8444-444444444441'
const secondItemId = '44444444-4444-4444-8444-444444444442'

function moduleContent(title: string) {
  return JSON.stringify({
    title, lessons: [{ title: 'Lesson', body: 'Body.' }],
    exercises: [
      { id: crypto.randomUUID(), type: 'multiple_choice', prompt: 'Pick', options: ['A', 'B'], answer: 'A', explanation: 'A.' },
      { id: crypto.randomUUID(), type: 'written', prompt: 'Explain', options: [], answer: 'Reference', explanation: 'Reason.' },
      { id: crypto.randomUUID(), type: 'code', prompt: 'Code', options: [], answer: 'Reference', explanation: 'Reason.' },
    ],
  })
}

function exerciseSnapshot(prompt: string) {
  return JSON.stringify({ id: crypto.randomUUID(), type: 'multiple_choice', prompt, options: ['A', 'B'], answer: 'A', explanation: 'A.' })
}

function createLegacyDatabase(path: string, options: { duplicatePosition: boolean }) {
  const database = new Database(path, { create: true })
  database.run('PRAGMA journal_mode = WAL')
  database.run('PRAGMA foreign_keys = ON')
  database.run('CREATE TABLE courses (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, created_at TEXT NOT NULL)')
  database.run(`CREATE TABLE modules (id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, position INTEGER NOT NULL, content TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, accepted_at INTEGER, created_at INTEGER NOT NULL DEFAULT 0)`)
  database.run('CREATE UNIQUE INDEX modules_course_position ON modules(course_id, position)')
  database.run(`CREATE TABLE assessments (
    id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, title TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('timed', 'untimed')), duration_seconds INTEGER,
    status TEXT NOT NULL CHECK(status IN ('planned', 'active', 'submitted', 'expired')), scope TEXT NOT NULL,
    created_at INTEGER NOT NULL, started_at INTEGER, deadline_at INTEGER, submitted_at INTEGER, finalized_at INTEGER, version INTEGER NOT NULL DEFAULT 0
  )`)
  database.run(`CREATE TABLE assessment_items (
    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, module_id TEXT NOT NULL, module_title TEXT NOT NULL, exercise_id TEXT NOT NULL,
    exercise_index INTEGER NOT NULL, content TEXT NOT NULL,
    ${options.duplicatePosition ? '' : 'UNIQUE(assessment_id, position),'}
    UNIQUE(assessment_id, exercise_id)
  )`)
  database.run(`CREATE TABLE assessment_answers (
    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES assessment_items(id) ON DELETE CASCADE,
    answer TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(assessment_id, item_id)
  )`)
  database.run(`CREATE TABLE assessment_results (
    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES assessment_items(id) ON DELETE CASCADE, answer TEXT, correct INTEGER,
    grading TEXT NOT NULL CHECK(grading IN ('deterministic', 'unscored')), feedback TEXT NOT NULL DEFAULT '',
    advisory INTEGER NOT NULL DEFAULT 0, owner_note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
    UNIQUE(assessment_id, item_id)
  )`)
  database.run('INSERT INTO courses (id, title, goal, created_at) VALUES (?, ?, ?, ?)', [courseId, 'Existing course', 'Keep data.', '2026-11-01T00:00:00.000Z'])
  database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, 1, ?, 1, 0)', [firstModuleId, courseId, moduleContent('First module')])
  database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, 2, ?, 1, 0)', [secondModuleId, courseId, moduleContent('Second module')])
  database.run('INSERT INTO assessments (id, course_id, title, mode, duration_seconds, status, scope, created_at, version) VALUES (?, ?, ?, ?, NULL, ?, ?, 100, 1)', [assessmentId, courseId, 'Existing assessment', 'untimed', 'planned', JSON.stringify({ modules: [], lessonCount: 0, exerciseCount: 2 })])
  const firstContent = exerciseSnapshot('First prompt')
  const secondContent = exerciseSnapshot('Second prompt')
  database.run('INSERT INTO assessment_items (id, assessment_id, position, module_id, module_title, exercise_id, exercise_index, content) VALUES (?, ?, 1, ?, ?, ?, 0, ?)', [firstItemId, assessmentId, firstModuleId, 'First module', '55555555-5555-4555-8555-555555555551', firstContent])
  database.run('INSERT INTO assessment_items (id, assessment_id, position, module_id, module_title, exercise_id, exercise_index, content) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', [secondItemId, assessmentId, options.duplicatePosition ? 1 : 2, secondModuleId, 'Second module', '55555555-5555-4555-8555-555555555552', secondContent])
  database.run('INSERT INTO assessment_answers (assessment_id, item_id, answer, updated_at) VALUES (?, ?, ?, ?)', [assessmentId, firstItemId, 'A', 101])
  database.run('INSERT INTO assessment_results (id, assessment_id, item_id, answer, correct, grading, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['66666666-6666-4666-8666-666666666666', assessmentId, firstItemId, 'A', 1, 'deterministic', 102])
  database.close()
  return { firstContent, secondContent }
}

function uniqueIndexColumns(database: Database) {
  const indexes = database.query('PRAGMA index_list(assessment_items)').all() as { name: string; unique: number }[]
  return indexes.filter((index) => index.unique).map((index) => (database.query(`PRAGMA index_info("${index.name}")`).all() as { name: string }[]).map((column) => column.name)).filter((names) => names.join(',') !== 'id').map((names) => names.join(',')).sort()
}

describe('assessment item uniqueness migration', () => {
  test('rebuilds legacy items with module-scoped uniqueness while preserving IDs and answer/result references', () => {
    const path = join(directory, 'legacy.sqlite')
    const legacy = createLegacyDatabase(path, { duplicatePosition: false })
    const database = openDatabase(path)
    expect(database.query('SELECT id, assessment_id, position, module_id, exercise_id, exercise_index FROM assessment_items ORDER BY position').all()).toEqual([
      { id: firstItemId, assessment_id: assessmentId, position: 1, module_id: firstModuleId, exercise_id: '55555555-5555-4555-8555-555555555551', exercise_index: 0 },
      { id: secondItemId, assessment_id: assessmentId, position: 2, module_id: secondModuleId, exercise_id: '55555555-5555-4555-8555-555555555552', exercise_index: 0 },
    ])
    expect(database.query('SELECT content FROM assessment_items WHERE id = ?').get(firstItemId)).toEqual({ content: legacy.firstContent })
    expect(database.query('SELECT content FROM assessment_items WHERE id = ?').get(secondItemId)).toEqual({ content: legacy.secondContent })
    expect(database.query('SELECT assessment_id, item_id, answer FROM assessment_answers').get()).toEqual({ assessment_id: assessmentId, item_id: firstItemId, answer: 'A' })
    expect(database.query('SELECT assessment_id, item_id, answer, correct, grading FROM assessment_results').get()).toEqual({ assessment_id: assessmentId, item_id: firstItemId, answer: 'A', correct: 1, grading: 'deterministic' })
    expect(uniqueIndexColumns(database)).toEqual(['assessment_id,module_id,exercise_id', 'assessment_id,position'])
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])

    // The same exercise ID may now appear once per module in one assessment.
    database.run('INSERT INTO assessment_items (id, assessment_id, position, module_id, module_title, exercise_id, exercise_index, content) VALUES (?, ?, 3, ?, ?, ?, 0, ?)', [crypto.randomUUID(), assessmentId, firstModuleId, 'First module', '77777777-7777-4777-8777-777777777771', exerciseSnapshot('Third')])
    database.run('INSERT INTO assessment_items (id, assessment_id, position, module_id, module_title, exercise_id, exercise_index, content) VALUES (?, ?, 4, ?, ?, ?, 0, ?)', [crypto.randomUUID(), assessmentId, secondModuleId, 'Second module', '77777777-7777-4777-8777-777777777771', exerciseSnapshot('Fourth')])
    expect(database.query('SELECT COUNT(*) AS count FROM assessment_items').get()).toEqual({ count: 4 })
    database.close()

    const reopened = openDatabase(path)
    expect(reopened.query('SELECT COUNT(*) AS count FROM assessment_items').get()).toEqual({ count: 4 })
    expect(uniqueIndexColumns(reopened)).toEqual(['assessment_id,module_id,exercise_id', 'assessment_id,position'])
    expect(reopened.query('SELECT COUNT(*) AS count FROM assessment_answers').get()).toEqual({ count: 1 })
    expect(reopened.query('SELECT COUNT(*) AS count FROM assessment_results').get()).toEqual({ count: 1 })
    reopened.close()
  })

  test('rolls back a failed rebuild and leaves legacy items and their references intact', () => {
    const path = join(directory, 'rollback.sqlite')
    createLegacyDatabase(path, { duplicatePosition: true })
    expect(() => openDatabase(path)).toThrow()
    const raw = new Database(path)
    expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('assessment_items', 'assessment_items_new') ORDER BY name").all()).toEqual([{ name: 'assessment_items' }])
    expect(raw.query('SELECT COUNT(*) AS count FROM assessment_items').get()).toEqual({ count: 2 })
    expect(raw.query('SELECT item_id FROM assessment_answers').get()).toEqual({ item_id: firstItemId })
    expect(raw.query('SELECT item_id FROM assessment_results').get()).toEqual({ item_id: firstItemId })
    expect(uniqueIndexColumns(raw)).toEqual(['assessment_id,exercise_id'])
    raw.close()
  })
})
