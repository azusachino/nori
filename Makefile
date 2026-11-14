.PHONY: dev build check e2e e2e-install e2e-probe

dev:
	bun run dev

build:
	bun run build

check: build
	bun run typecheck
	bun test src

e2e:
	bunx playwright test --project chromium --project mobile

e2e-probe:
	PROBE_ROUTE=$(or $(ROUTE),/) bunx playwright test --project probe

e2e-install:
	bunx playwright install chromium
