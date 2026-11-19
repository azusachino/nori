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

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const database = new Database(path, { create: true })
  try {
    database.run('PRAGMA journal_mode = WAL')
    database.run('PRAGMA foreign_keys = ON')
    migrate(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
