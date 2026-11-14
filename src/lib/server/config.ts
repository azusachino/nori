import { existsSync } from 'node:fs'

export function setting(name: string): string | undefined {
  return process.env[`NORI_${name}`] || process.env[`SAME_${name}`]
}

export function databasePath(): string {
  return setting('DATABASE_PATH') || (existsSync('.data/same.sqlite') ? '.data/same.sqlite' : '.data/nori.sqlite')
}
