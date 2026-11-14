import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const path = process.env.SAME_DATABASE_PATH || '.data/same.sqlite'
mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
export const db = new Database(path, { create: true })
chmodSync(path, 0o600)
db.run('PRAGMA journal_mode = WAL')
db.run('PRAGMA foreign_keys = ON')
db.run(`CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`)
db.run(`CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  created_at TEXT NOT NULL
)`)
const columns = db.query('PRAGMA table_info(courses)').all() as { name: string }[]
if (!columns.some((column) => column.name === 'outline')) db.run("ALTER TABLE courses ADD COLUMN outline TEXT NOT NULL DEFAULT ''")
if (!columns.some((column) => column.name === 'outline_approved')) db.run('ALTER TABLE courses ADD COLUMN outline_approved INTEGER NOT NULL DEFAULT 0')
db.run(`CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content BLOB NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`)
db.run(`CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0
)`)
db.run(`CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  exercise_index INTEGER NOT NULL,
  answer TEXT NOT NULL,
  feedback TEXT NOT NULL,
  correct INTEGER,
  created_at INTEGER NOT NULL,
  owner_note TEXT NOT NULL DEFAULT '',
  exercise_id TEXT
)`)
const attemptColumns = db.query('PRAGMA table_info(attempts)').all() as { name: string }[]
if (!attemptColumns.some((column) => column.name === 'owner_note')) db.run("ALTER TABLE attempts ADD COLUMN owner_note TEXT NOT NULL DEFAULT ''")
if (!attemptColumns.some((column) => column.name === 'exercise_id')) db.run('ALTER TABLE attempts ADD COLUMN exercise_id TEXT')
const migrateExerciseIds = db.transaction(() => {
  const modules = db.query('SELECT id, content FROM modules').all() as { id: string; content: string }[]
  for (const row of modules) {
    const content = JSON.parse(row.content) as { exercises?: { id?: string }[] }
    if (!Array.isArray(content.exercises)) throw new Error('Cannot migrate invalid module exercises')
    let changed = false
    content.exercises.forEach((exercise, index) => {
      if (!exercise.id) { exercise.id = crypto.randomUUID(); changed = true }
      db.run('UPDATE attempts SET exercise_id = ? WHERE module_id = ? AND exercise_index = ? AND exercise_id IS NULL', [exercise.id, row.id, index])
    })
    if (changed) db.run('UPDATE modules SET content = ? WHERE id = ?', [JSON.stringify(content), row.id])
  }
})
migrateExerciseIds()
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`)
