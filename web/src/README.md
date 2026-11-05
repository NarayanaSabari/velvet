# src

## Overview
React 19 SPA source. `main.tsx` mounts `RouterProvider` inside `QueryClientProvider` under `StrictMode`.

## Interface
- `main.tsx`: entry point, requires `#root` in `index.html`.
- `index.css`: global tokens (see repository `design.md`).
- `test-setup.ts`: Vitest jsdom setup.
- [app](./app/README.md) - workspace shell and navigation.
- [features](./features/README.md) - route-level feature modules.
- [lib](./lib/README.md) - API client, query client, types, SSE stream.
- [routes](./routes/README.md) - router tree.
- [ui](./ui/README.md) - shared primitives.

## Invariants
- `main.tsx` throws `missing #root` when the mount node is absent.

## Side Effects
- Renders into the DOM.

## Verification
- Run: `cd web && pnpm run test`
