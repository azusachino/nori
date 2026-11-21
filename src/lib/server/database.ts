import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate as runDrizzleMigrations } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sidecarSchema } from './schema'

const DRIZZLE_MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle', import.meta.url))

export function migrate(database: Database) {
  runDrizzleMigrations(drizzle(database, { schema: sidecarSchema }), {
    migrationsFolder: DRIZZLE_MIGRATIONS_DIR,
  })
}

/**
 * Per-connection settings. WAL persists in the file, so only switch when it is
 * not already set; busy_timeout and synchronous apply to this connection only.
 */
export function applyPragmas(database: Database) {
  // Wait for a competing writer (backup, digest CLI) instead of failing with SQLITE_BUSY.
  database.run('PRAGMA busy_timeout = 5000')
  const mode = database.query('PRAGMA journal_mode').get() as { journal_mode: string } | null
  if (mode?.journal_mode.toLowerCase() !== 'wal') database.run('PRAGMA journal_mode = WAL')
  // With WAL, NORMAL is durable against application crashes and only risks the
  // last transactions on power loss, which this single-learner store accepts.
  database.run('PRAGMA synchronous = NORMAL')
  database.run('PRAGMA foreign_keys = ON')
}

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const database = new Database(path, { create: true })
  try {
    applyPragmas(database)
    migrate(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
