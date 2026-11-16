import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function tableColumns(database: Database, table: string): string[] {
  return (database.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name)
}

function legacyUniqueCourseIndex(database: Database): boolean {
  const indexes = database.query('PRAGMA index_list(modules)').all() as { name: string; unique: number }[]
  return indexes.filter((index) => index.unique).some((index) => {
    const names = (database.query(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all() as { name: string }[]).map((column) => column.name)
    return names.length === 1 && names[0] === 'course_id'
  })
}

function createModulesTable(database: Database) {
  database.run(`CREATE TABLE IF NOT EXISTS modules (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0,
    accepted_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT 0
  )`)
  database.run('CREATE UNIQUE INDEX IF NOT EXISTS modules_course_position ON modules(course_id, position)')
}

// Rebuilds the original one-module table (UNIQUE course_id, no position) in place.
// Runs only while the legacy constraint is present, so a restart is a no-op.
function migrateModules(database: Database) {
  const exists = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'modules'").get()
  if (!exists) { createModulesTable(database); return }
  const names = tableColumns(database, 'modules')
  const legacy = legacyUniqueCourseIndex(database)
  if (names.includes('position') && !legacy) {
    database.run('CREATE UNIQUE INDEX IF NOT EXISTS modules_course_position ON modules(course_id, position)')
    return
  }
  const source = (column: string, fallback: string) => names.includes(column) ? `"${column}"` : fallback
  database.run('PRAGMA foreign_keys = OFF')
  try {
    database.transaction(() => {
      database.run('DROP TABLE IF EXISTS modules_new')
      database.run(`CREATE TABLE modules_new (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        content TEXT NOT NULL,
        accepted INTEGER NOT NULL DEFAULT 0,
        accepted_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT 0
      )`)
      database.run(`INSERT INTO modules_new (id, course_id, position, content, accepted, accepted_at, created_at)
        SELECT id, course_id, ${source('position', '1')}, content, accepted, ${source('accepted_at', 'NULL')}, ${source('created_at', '0')} FROM modules`)
      database.run('DROP TABLE modules')
      database.run('ALTER TABLE modules_new RENAME TO modules')
      database.run('CREATE UNIQUE INDEX modules_course_position ON modules(course_id, position)')
      const violations = database.query('PRAGMA foreign_key_check').all()
      if (violations.length) throw new Error('Module migration left inconsistent attempts')
    })()
  } finally {
    database.run('PRAGMA foreign_keys = ON')
  }
}

function migrateExerciseIds(database: Database) {
  database.transaction(() => {
    const modules = database.query('SELECT id, content FROM modules').all() as { id: string; content: string }[]
    for (const row of modules) {
      const content = JSON.parse(row.content) as { exercises?: { id?: string }[] }
      if (!Array.isArray(content.exercises)) throw new Error('Cannot migrate invalid module exercises')
      let changed = false
      content.exercises.forEach((exercise, index) => {
        if (!exercise.id) { exercise.id = crypto.randomUUID(); changed = true }
        database.run('UPDATE attempts SET exercise_id = ? WHERE module_id = ? AND exercise_index = ? AND exercise_id IS NULL', [exercise.id, row.id, index])
      })
      if (changed) database.run('UPDATE modules SET content = ? WHERE id = ?', [JSON.stringify(content), row.id])
    }
  })()
}

export function migrate(database: Database) {
  database.run(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`)
  database.run(`CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)
  const courseColumns = tableColumns(database, 'courses')
  if (!courseColumns.includes('outline')) database.run("ALTER TABLE courses ADD COLUMN outline TEXT NOT NULL DEFAULT ''")
  if (!courseColumns.includes('outline_approved')) database.run('ALTER TABLE courses ADD COLUMN outline_approved INTEGER NOT NULL DEFAULT 0')
  database.run(`CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content BLOB NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  migrateModules(database)
  database.run(`CREATE TABLE IF NOT EXISTS attempts (
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
  const attemptColumns = tableColumns(database, 'attempts')
  if (!attemptColumns.includes('owner_note')) database.run("ALTER TABLE attempts ADD COLUMN owner_note TEXT NOT NULL DEFAULT ''")
  if (!attemptColumns.includes('exercise_id')) database.run('ALTER TABLE attempts ADD COLUMN exercise_id TEXT')
  database.run('CREATE INDEX IF NOT EXISTS attempts_module ON attempts(module_id)')
  migrateExerciseIds(database)
  database.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
}

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const database = new Database(path, { create: true })
  try {
    chmodSync(path, 0o600)
    database.run('PRAGMA journal_mode = WAL')
    database.run('PRAGMA foreign_keys = ON')
    migrate(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
