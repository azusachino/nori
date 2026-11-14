import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setting } from './config'

afterEach(() => {
  delete process.env.NORI_RENAME_TEST
  delete process.env.SAME_RENAME_TEST
})

describe('renamed configuration', () => {
  test('accepts the previous setting and prefers the new one', () => {
    process.env.SAME_RENAME_TEST = 'previous'
    expect(setting('RENAME_TEST')).toBe('previous')
    process.env.NORI_RENAME_TEST = 'current'
    expect(setting('RENAME_TEST')).toBe('current')
  })
  test('keeps the previous default database when it exists', () => {
    const dir = resolve('.tmp/nori-rename-compat')
    mkdirSync(`${dir}/.data`, { recursive: true })
    writeFileSync(`${dir}/.data/same.sqlite`, '')
    const { NORI_DATABASE_PATH: _new, SAME_DATABASE_PATH: _old, ...env } = process.env
    const script = `import { databasePath } from ${JSON.stringify(resolve('src/lib/server/config.ts'))}; console.log(databasePath())`
    const result = Bun.spawnSync(['bun', '-e', script], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe('.data/same.sqlite')
  })
})
