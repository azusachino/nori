# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS build

WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1-alpine AS runtime

RUN apk add --no-cache tini ca-certificates \
    && mkdir -p /data \
    && chown -R bun:bun /data

WORKDIR /app
COPY --from=build --chown=bun:bun /build/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun drizzle ./drizzle
COPY --chown=bun:bun src/sidecar-server.ts ./src/sidecar-server.ts
COPY --chown=bun:bun src/lib ./src/lib

USER bun

ENV NORI_HOST=0.0.0.0 \
    NORI_PORT=3001 \
    NORI_BASE_PATH=/api/nori \
    NORI_DATABASE_PATH=/data/nori.sqlite

EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "src/sidecar-server.ts"]
