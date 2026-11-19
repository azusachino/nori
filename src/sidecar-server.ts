import { setting } from './lib/server/config'
import { db } from './lib/server/db'
import { createSidecarApi } from './lib/server/sidecar'

const hostname = setting('HOST') || '127.0.0.1'
const port = Number(setting('PORT') || 3001)
const basePath = setting('BASE_PATH') ?? '/api/nori'

const handle = createSidecarApi(db, { basePath })

const server = Bun.serve({
  hostname,
  port,
  fetch: handle,
})

console.log(`nori sidecar listening on http://${server.hostname}:${server.port}${basePath || '/'}`)
