FROM azusachino.com/media-base:py3.14-trixie-r2

RUN groupadd --system nori \
    && useradd --system --gid nori nori

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY drizzle ./drizzle
COPY src ./src

RUN mkdir -p /data && chown -R nori:nori /app /data
USER nori

ENV NORI_HOST=0.0.0.0 \
    NORI_PORT=3001 \
    NORI_BASE_PATH=/api/nori \
    NORI_DATABASE_PATH=/data/nori.sqlite

EXPOSE 3001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/sidecar-server.ts"]
