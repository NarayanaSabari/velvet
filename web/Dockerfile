FROM node:22-alpine AS build
WORKDIR /src
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# The built assets are handed to Caddy through a shared volume, so this image
# never serves anything itself.
FROM alpine:3.21 AS assets
COPY --from=build /src/dist /dist
