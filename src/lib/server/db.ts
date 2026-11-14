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
  created_at INTEGER NOT NULL
)`)
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`)
