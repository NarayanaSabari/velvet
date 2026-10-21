FROM node:22-alpine AS build
WORKDIR /src
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# The velvet CLI is served as plain files next to the SPA, so `install.sh`
# can download it from the same origin people already sign in to.
FROM golang:1.26.10-alpine AS cli
ARG VERSION=dev
WORKDIR /src
COPY cli/go.mod cli/go.sum ./
RUN go mod download
COPY cli/ ./
RUN set -e; mkdir -p /out; \
    for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64; do \
      os=${target%/*}; arch=${target#*/}; \
      CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath \
        -ldflags="-s -w -X main.version=${VERSION}" \
        -o /out/velvet-$os-$arch ./cmd/velvet; \
    done; \
    cd /out && sha256sum velvet-* > SHA256SUMS

# The built assets are handed to Caddy through a shared volume, so this image
# never serves anything itself.
FROM alpine:3.21 AS assets
COPY --from=build /src/dist /dist
COPY --from=cli /out /dist/download
