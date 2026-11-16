import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { openDatabase } from './database'
import { hashContent } from './modules'

mkdirSync('.tmp/nori-modules', { recursive: true })
const directory = mkdtempSync(join('.tmp/nori-modules', 'backup-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const courseId = '11111111-1111-4111-8111-111111111111'
const moduleId = '22222222-2222-4222-8222-222222222222'
const draftModuleId = '22222222-2222-4222-8222-222222222223'
const attemptId = '33333333-3333-4333-8333-333333333331'
const assessmentId = '44444444-4444-4444-8444-444444444444'
const firstItemId = '55555555-5555-4555-8555-555555555551'
const secondItemId = '55555555-5555-4555-8555-555555555552'
const userTurnId = '66666666-6666-4666-8666-666666666661'
const assistantTurnId = '66666666-6666-4666-8666-666666666662'
const proposalId = '77777777-7777-4777-8777-777777777777'
const exerciseId = '88888888-8888-4888-8888-888888888888'

const lesson = { title: 'Backup lesson', body: 'Backed up lesson body.' }
const exercises = [
  { id: exerciseId, type: 'multiple_choice' as const, prompt: 'Pick A', options: ['A', 'B'], answer: 'A', explanation: 'A is correct.' },
  { id: '88888888-8888-4888-8888-888888888889', type: 'written' as const, prompt: 'Explain', options: [], answer: 'Reference', explanation: 'Reason.' },
  { id: '88888888-8888-4888-8888-888888888890', type: 'code' as const, prompt: 'Code', options: [], answer: 'Code', explanation: 'Code reason.' },
]
const content = JSON.stringify({ title: 'Accepted module', lessons: [lesson], exercises })
const draftContent = JSON.stringify({ title: 'Draft module', lessons: [{ title: 'Draft lesson', body: 'Draft body.' }], exercises })
const scope = JSON.stringify({ modules: [{ id: moduleId, title: 'Accepted module', lessons: 1, exercises: 3 }], lessonCount: 1, exerciseCount: 3 })
const itemContent = JSON.stringify(exercises[0])
const context = JSON.stringify({ moduleId, lessonIndex: 0, lessonTitle: lesson.title, lessonText: lesson.body, attempts: [], sourceIds: [], contextLimit: 120000, contextChars: 10, historyTurnsIncluded: 0, historyTurnsDropped: 0, history: [], conversationRevision: 0 })
const draftHash = hashContent(draftContent)

function seed(database: Database) {
  database.run('PRAGMA wal_autocheckpoint = 0')
  database.run('INSERT INTO courses (id, title, goal, created_at, outline, outline_approved) VALUES (?, ?, ?, ?, ?, 1)', [courseId, 'Backup course', 'Keep everything.', '2026-11-01T00:00:00.000Z', 'Module 1'])
  database.run('INSERT INTO modules (id, course_id, position, content, accepted, accepted_at, created_at) VALUES (?, ?, 1, ?, 1, ?, 100)', [moduleId, courseId, content, 101])
  database.run('INSERT INTO modules (id, course_id, position, content, accepted, created_at) VALUES (?, ?, 2, ?, 0, 102)', [draftModuleId, courseId, draftContent])
  database.run('INSERT INTO attempts (id, module_id, exercise_index, answer, feedback, correct, created_at, owner_note, exercise_id) VALUES (?, ?, 0, ?, ?, 1, ?, ?, ?)', [attemptId, moduleId, 'A', 'Correct.', 200, 'The reference is also valid.', exerciseId])
  database.run('INSERT INTO assessments (id, course_id, title, mode, duration_seconds, status, scope, created_at, started_at, deadline_at, submitted_at, finalized_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3)', [assessmentId, courseId, 'Backup assessment', 'timed', 60, 'submitted', scope, 300, 300, 60000, 900, 900])
  database.run('INSERT INTO assessment_items (id, assessment_id, position, module_id, module_title, exercise_id, exercise_index, content) VALUES (?, ?, 1, ?, ?, ?, 0, ?)', [firstItemId, assessmentId, moduleId, 'Accepted module', exerciseId, itemContent])
  database.run('INSERT INTO assessment_items (id, assessment_id, position, module_id, module_title, exercise_id, exercise_index, content) VALUES (?, ?, 2, ?, ?, ?, 1, ?)', [secondItemId, assessmentId, moduleId, 'Accepted module', exercises[1]!.id, JSON.stringify(exercises[1])])
  database.run('INSERT INTO assessment_answers (assessment_id, item_id, answer, updated_at) VALUES (?, ?, ?, ?)', [assessmentId, firstItemId, 'A', 901])
  database.run('INSERT INTO assessment_results (id, assessment_id, item_id, answer, correct, grading, feedback, advisory, owner_note, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?, ?)', ['99999999-9999-4999-8999-999999999991', assessmentId, firstItemId, 'A', 'deterministic', '', 'Assessment correction.', 902])
  database.run('INSERT INTO assessment_results (id, assessment_id, item_id, answer, correct, grading, feedback, advisory, owner_note, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, 1, ?, ?)', ['99999999-9999-4999-8999-999999999992', assessmentId, secondItemId, 'unscored', 'Advisory feedback.', '', 903])
  database.run('INSERT INTO tutor_turns (id, course_id, module_id, lesson_index, role, content, context, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)', [userTurnId, courseId, moduleId, 'user', 'Explain the attempt.', context, 400])
  database.run('INSERT INTO tutor_turns (id, course_id, module_id, lesson_index, role, content, context, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)', [assistantTurnId, courseId, moduleId, 'assistant', 'Use the reference and your note.', context, 400])
  database.run('INSERT INTO tutor_proposals (id, course_id, module_id, lesson_index, turn_id, content, context, draft_id, draft_position, draft_content_hash, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 2, ?, ?)', [proposalId, courseId, moduleId, assistantTurnId, 'PROPOSAL: add a worked example.', context, draftModuleId, draftHash, 401])
}

function assertCriticalData(database: Database) {
  expect(database.query('SELECT id, title, goal, outline, outline_approved FROM courses').get()).toEqual({ id: courseId, title: 'Backup course', goal: 'Keep everything.', outline: 'Module 1', outline_approved: 1 })
  expect(database.query('SELECT id, position, content, accepted, accepted_at FROM modules ORDER BY position').all()).toEqual([
    { id: moduleId, position: 1, content, accepted: 1, accepted_at: 101 },
    { id: draftModuleId, position: 2, content: draftContent, accepted: 0, accepted_at: null },
  ])
  expect(database.query('SELECT id, module_id, exercise_id, answer, feedback, correct, owner_note FROM attempts').get()).toEqual({ id: attemptId, module_id: moduleId, exercise_id: exerciseId, answer: 'A', feedback: 'Correct.', correct: 1, owner_note: 'The reference is also valid.' })
  expect(database.query('SELECT id, status, mode, duration_seconds, submitted_at, finalized_at, version FROM assessments').get()).toEqual({ id: assessmentId, status: 'submitted', mode: 'timed', duration_seconds: 60, submitted_at: 900, finalized_at: 900, version: 3 })
  expect(database.query('SELECT id, assessment_id, position, module_id, exercise_id, content FROM assessment_items ORDER BY position').all()).toEqual([
    { id: firstItemId, assessment_id: assessmentId, position: 1, module_id: moduleId, exercise_id: exerciseId, content: itemContent },
    { id: secondItemId, assessment_id: assessmentId, position: 2, module_id: moduleId, exercise_id: exercises[1]!.id, content: JSON.stringify(exercises[1]) },
  ])
  expect(database.query('SELECT assessment_id, item_id, answer FROM assessment_answers').get()).toEqual({ assessment_id: assessmentId, item_id: firstItemId, answer: 'A' })
  expect(database.query('SELECT item_id, answer, correct, grading, feedback, advisory, owner_note FROM assessment_results ORDER BY item_id').all()).toEqual([
    { item_id: firstItemId, answer: 'A', correct: 1, grading: 'deterministic', feedback: '', advisory: 0, owner_note: 'Assessment correction.' },
    { item_id: secondItemId, answer: null, correct: null, grading: 'unscored', feedback: 'Advisory feedback.', advisory: 1, owner_note: '' },
  ])
  expect(database.query('SELECT id, role, content, context FROM tutor_turns ORDER BY rowid').all()).toEqual([
    { id: userTurnId, role: 'user', content: 'Explain the attempt.', context },
    { id: assistantTurnId, role: 'assistant', content: 'Use the reference and your note.', context },
  ])
  expect(database.query('SELECT id, turn_id, content, draft_id, draft_position, draft_content_hash FROM tutor_proposals').get()).toEqual({ id: proposalId, turn_id: assistantTurnId, content: 'PROPOSAL: add a worked example.', draft_id: draftModuleId, draft_position: 2, draft_content_hash: draftHash })
  expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
  expect(database.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
}

describe('SQLite online backup and restore', () => {
  test('backs up a live WAL database with VACUUM INTO and restores a consistent independent copy', () => {
    const sourcePath = join(directory, 'source.sqlite')
    const source = openDatabase(sourcePath)
    let restored: Database | null = null
    try {
      expect(source.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      seed(source)
      expect(statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0)
      const before = {
        modules: source.query('SELECT id, position, content FROM modules ORDER BY position').all(),
        attempts: source.query('SELECT id, answer, feedback, correct, owner_note FROM attempts ORDER BY id').all(),
        assessments: source.query('SELECT id, status, version FROM assessments ORDER BY id').all(),
      }

      const backupPath = join(directory, 'backup.sqlite')
      source.run(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`)
      expect(existsSync(backupPath)).toBe(true)
      expect(statSync(backupPath).size).toBeGreaterThan(0)
      expect(existsSync(`${backupPath}-wal`)).toBe(false)
      expect(source.query('SELECT id, position, content FROM modules ORDER BY position').all()).toEqual(before.modules)
      expect(source.query('SELECT id, answer, feedback, correct, owner_note FROM attempts ORDER BY id').all()).toEqual(before.attempts)
      expect(source.query('SELECT id, status, version FROM assessments ORDER BY id').all()).toEqual(before.assessments)
      source.close()

      // Restore is a stopped-server operation: the backup is an independent single file.
      const restoredPath = join(directory, 'restored.sqlite')
      copyFileSync(backupPath, restoredPath)
      expect(existsSync(`${restoredPath}-wal`)).toBe(false)
      restored = openDatabase(restoredPath)
      assertCriticalData(restored)
      const revision = (restored.query('SELECT COUNT(*) AS count FROM tutor_turns').get() as { count: number }).count
      expect(revision).toBe(2)
      restored.close()
      restored = openDatabase(restoredPath)
      assertCriticalData(restored)
    } finally {
      if (restored) restored.close()
      try { source.close() } catch { /* already closed */ }
    }
  })
})
