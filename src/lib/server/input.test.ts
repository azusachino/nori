import { describe, expect, test } from 'bun:test'
import { readJson } from './input'

describe('request body limits', () => {
  test('accepts bounded JSON', async () => {
    const request = new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })
    expect(await readJson(request, 100)).toEqual({ ok: true })
  })
  test('rejects a body over the limit without trusting content-length', async () => {
    const request = new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(1000) }) })
    expect(await readJson(request, 20)).toBeNull()
  })
})
