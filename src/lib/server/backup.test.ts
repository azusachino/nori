import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from './database'
import { practiceAttempts, sidecarAssessments, sidecarSchema, sidecarTutorLessons, sidecarTutorTurns } from './schema'

mkdirSync('.tmp/nori-backup', { recursive: true })
const directory = mkdtempSync(join('.tmp/nori-backup', 'backup-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const attemptId = '33333333-3333-4333-8333-333333333331'
const assessmentId = '44444444-4444-4444-8444-444444444444'
const turnId = '66666666-6666-4666-8666-666666666661'
const lessonHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function seed(database: Database) {
  database.run('PRAGMA wal_autocheckpoint = 0')
  const orm = drizzle(database, { schema: sidecarSchema })
  orm
    .insert(practiceAttempts)
    .values({
      id: attemptId,
      courseKey: 'ai/stanford-cs229-ml',
      lessonKey: '01-glms',
      exerciseKey: 'q-1',
      contentHash: 'hash1',
      exerciseSnapshot: JSON.stringify({ type: 'written', prompt: 'Explain', options: [], answer: 'Ref', explanation: '' }),
      answer: 'My answer',
      correct: null,
      grading: 'unscored',
      feedback: 'Advisory feedback.',
      advisory: 1,
      ownerNote: 'Checked.',
      version: 2,
      createdAt: 100,
      updatedAt: 200,
    })
    .run()
  orm
    .insert(sidecarAssessments)
    .values({
      id: assessmentId,
      courseKey: 'ai/stanford-cs229-ml',
      title: 'Midterm check',
      mode: 'timed',
      durationSeconds: 600,
      status: 'submitted',
      createdAt: 300,
      startedAt: 310,
      deadlineAt: 910,
      submittedAt: 500,
      finalizedAt: 500,
      version: 3,
    })
    .run()
  orm
    .insert(sidecarTutorLessons)
    .values({ hash: lessonHash, title: 'GLMs', body: 'Exponential family notes.', createdAt: 400 })
    .run()
  orm
    .insert(sidecarTutorTurns)
    .values({
      id: turnId,
      courseKey: 'ai/stanford-cs229-ml',
      lessonKey: '01-glms',
      role: 'user',
      content: 'Why canonical link?',
      lessonHash,
      contextMeta: JSON.stringify({ attemptIds: [attemptId] }),
      createdAt: 410,
    })
    .run()
}

function assertCriticalData(database: Database) {
  const orm = drizzle(database, { schema: sidecarSchema })
  expect(orm.select().from(practiceAttempts).all()).toHaveLength(1)
  expect(orm.select().from(sidecarAssessments).all()).toHaveLength(1)
  expect(orm.select().from(sidecarTutorLessons).all()).toHaveLength(1)
  expect(orm.select().from(sidecarTutorTurns).all()).toHaveLength(1)
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

      const backupPath = join(directory, 'backup.sqlite')
      source.run(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`)
      expect(existsSync(backupPath)).toBe(true)
      expect(statSync(backupPath).size).toBeGreaterThan(0)
      expect(existsSync(`${backupPath}-wal`)).toBe(false)
      source.close()

      const restoredPath = join(directory, 'restored.sqlite')
      copyFileSync(backupPath, restoredPath)
      expect(existsSync(`${restoredPath}-wal`)).toBe(false)
      restored = openDatabase(restoredPath)
      assertCriticalData(restored)
      restored.close()
      restored = openDatabase(restoredPath)
      assertCriticalData(restored)
    } finally {
      if (restored) restored.close()
      try {
        source.close()
      } catch {
        /* already closed */
      }
    }
  })
})
