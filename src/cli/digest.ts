#!/usr/bin/env bun
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { databasePath } from '../lib/server/config'
import { openDatabase } from '../lib/server/database'
import { buildRecallDigest, type RecallDigestResponse } from '../lib/server/review'
import { sidecarSchema } from '../lib/server/schema'

function parseArgs(argv: string[]) {
  let courseKey: string | undefined
  let dbPath: string | undefined
  let apiUrl: string | undefined
  let outFile: string | undefined
  let jsonOutput = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if ((arg === '--course' || arg === '-c') && argv[i + 1]) {
      courseKey = argv[++i]
    } else if (arg.startsWith('--course=')) {
      courseKey = arg.slice('--course='.length)
    } else if (arg === '--db' && argv[i + 1]) {
      dbPath = argv[++i]
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length)
    } else if (arg === '--api' && argv[i + 1]) {
      apiUrl = argv[++i]
    } else if (arg.startsWith('--api=')) {
      apiUrl = arg.slice('--api='.length)
    } else if ((arg === '--out' || arg === '-o') && argv[i + 1]) {
      outFile = argv[++i]
    } else if (arg.startsWith('--out=')) {
      outFile = arg.slice('--out='.length)
    } else if (arg === '--json') {
      jsonOutput = true
    }
  }

  return { courseKey, dbPath, apiUrl, outFile, jsonOutput }
}

export async function runDigestCli(argv = process.argv.slice(2)): Promise<RecallDigestResponse> {
  const { courseKey, dbPath, apiUrl, outFile, jsonOutput } = parseArgs(argv)
  let digest: RecallDigestResponse

  if (apiUrl) {
    const base = apiUrl.replace(/\/+$/, '')
    const query = courseKey ? `?courseKey=${encodeURIComponent(courseKey)}` : ''
    const res = await fetch(`${base}/digest${query}`)
    if (!res.ok) {
      throw new Error(`Digest API request failed (${res.status})`)
    }
    digest = (await res.json()) as RecallDigestResponse
  } else {
    const db = openDatabase(dbPath ?? databasePath())
    try {
      const orm = drizzle(db, { schema: sidecarSchema })
      digest = buildRecallDigest(orm, { courseKey })
    } finally {
      db.close()
    }
  }

  const outputText = jsonOutput ? JSON.stringify(digest, null, 2) + '\n' : digest.markdown

  if (outFile) {
    const target = resolve(outFile)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, outputText, 'utf8')
  } else if (import.meta.main) {
    process.stdout.write(outputText)
  }

  return digest
}

if (import.meta.main) {
  await runDigestCli()
}
