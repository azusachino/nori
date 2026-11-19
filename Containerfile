FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY drizzle ./drizzle
COPY src ./src

RUN mkdir -p /data && chown -R bun:bun /data /app

USER bun

ENV NORI_HOST=0.0.0.0 \
    NORI_PORT=3001 \
    NORI_BASE_PATH=/api/nori \
    NORI_DATABASE_PATH=/data/nori.sqlite

VOLUME ["/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "const base = (process.env.NORI_BASE_PATH ?? '/api/nori').replace(/\/+$/, ''); const res = await fetch('http://127.0.0.1:' + (process.env.NORI_PORT || 3001) + base + '/v1/health'); if (!res.ok) process.exit(1);"

CMD ["sh", "-c", "umask 077 && exec bun run src/sidecar-server.ts"]
