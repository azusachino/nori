.PHONY: dev start sidecar build build-sdk check

dev:
	bun run dev

start:
	bun run start

sidecar:
	bun run sidecar

build: build-sdk

build-sdk:
	bun run build:sdk

check: build-sdk
	bun run typecheck
	bun test src
