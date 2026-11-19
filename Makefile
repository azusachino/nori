.PHONY: dev start sidecar build build-sdk check image-app image-local images

IMAGE_NS := azusachino.com
TAG ?= $(error TAG is required, e.g. TAG=v0.1.0)
SOURCE_REVISION ?= $(shell git rev-parse HEAD)$(if $(shell git status --porcelain),-dirty)

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

image-app: ## Build the nori sidecar image and import it into local k3s containerd (TAG=v0.1.0)
	podman build --build-arg SOURCE_REVISION=$(SOURCE_REVISION) -f Containerfile -t $(IMAGE_NS)/nori:$(TAG) .
	podman save $(IMAGE_NS)/nori:$(TAG) | sudo k3s ctr images import --all-platforms --digests --skip-digest-for-named -

images: image-app ## Alias used by the ship-to-cluster playbook

image-local: ## Build only, no containerd import (TAG=v0.1.0)
	podman build --build-arg SOURCE_REVISION=$(SOURCE_REVISION) -f Containerfile -t $(IMAGE_NS)/nori:$(TAG) .
