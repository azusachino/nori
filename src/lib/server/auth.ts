import { createHash, randomBytes } from 'node:crypto'
import { db } from './db'
import { readJson } from './input'

const sessionAge = 60 * 60 * 24 * 7
const attempts = new Map<string, { count: number; until: number }>()
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export function sameOrigin(request: Request): boolean {
  const configured = process.env.SAME_ORIGIN || 'http://localhost:3000'
  return request.headers.get('origin') === configured && request.headers.get('host') === new URL(configured).host
}

export function authenticated(request: Request): boolean {
  const cookie = request.headers.get('cookie') || ''
  const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('same_session='))?.slice('same_session='.length)
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false
  return !!db.query('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hash(token), Date.now())
}

export async function login(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'Invalid request origin' }, { status: 403 })
  const key = 'owner'
  const now = Date.now()
  const previous = attempts.get(key)
  if (previous && previous.until > now && previous.count >= 10) return Response.json({ error: 'Try again later' }, { status: 429 })
  const body = await readJson(request, 4096) as { password?: unknown } | null
  const expected = process.env.SAME_PASSWORD_HASH
  if (!expected || typeof body?.password !== 'string' || body.password.length > 1024 || !(await Bun.password.verify(body.password, expected).catch(() => false))) {
    const current = previous && previous.until > now ? previous : { count: 0, until: now + 15 * 60 * 1000 }
    current.count++
    attempts.set(key, current)
    return Response.json({ error: 'Unable to sign in' }, { status: 401 })
  }
  attempts.delete(key)
  const token = randomBytes(32).toString('hex')
  db.run('DELETE FROM sessions WHERE expires_at <= ?', [now])
  db.run('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)', [hash(token), now + sessionAge * 1000])
  const secure = (process.env.SAME_ORIGIN || '').startsWith('https://') ? '; Secure' : ''
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': `same_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionAge}${secure}`, 'Cache-Control': 'no-store' } })
}

export function logout(request: Request): Response {
  if (!sameOrigin(request)) return Response.json({ error: 'Invalid request origin' }, { status: 403 })
  const token = (request.headers.get('cookie') || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('same_session='))?.slice('same_session='.length)
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', [hash(token)])
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'same_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' } })
}
