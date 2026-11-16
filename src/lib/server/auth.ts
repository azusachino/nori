import { setting } from './config'

export function validHost(request: Request): boolean {
  try {
    const configured = new URL(setting('ORIGIN') || 'http://localhost:3000')
    return request.headers.get('host') === configured.host
  } catch { return false }
}

export function sameOrigin(request: Request): boolean {
  try {
    const configured = new URL(setting('ORIGIN') || 'http://localhost:3000')
    return validHost(request) && request.headers.get('origin') === configured.origin
  } catch { return false }
}
