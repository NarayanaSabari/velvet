# Agent instructions

Read [`design.md`](design.md) before any UI, layout, interaction, or visual review work.

`design.md` is the source of truth for design rules, tokens, page archetypes, accessibility, responsive behavior, and the known Issues-page deviation.

This file describes repository structure, safe working practice, and verified commands without duplicating the design system.

## Repository map

- `api/` contains the Go HTTP API, database migrations, authentication, stores, GitHub integration, and queue worker.
- `web/` contains the React 19 and TypeScript SPA built with Vite, Tailwind, TanStack Router, and TanStack Query.
- `web/src/app/Shell.tsx` owns the shared workspace shell and responsive navigation.
- `web/src/index.css` owns the global palette, typography tokens, focus ring, radius tokens, and button motion contract.
- `web/src/ui/` contains shared primitives such as `Button`, `List`, `EmptyState`, `StatusBadge`, `Avatar`, `Markdown`, and `RelativeTime`.
- `web/src/features/` contains route-level features, including issues, sprints, dashboard, profile, administration, comments, and evidence.
- `web/src/routes/router.tsx` defines the route tree and maps workspace paths to feature components.
- `e2e/` contains the Playwright suite and the guarded disposable Compose stack used for real browser verification.
- `deploy/` contains the production-shaped Compose file, Caddy configuration, environment examples, backup tooling, and verification scripts.
- `docs/` contains product specifications, implementation plans, and operational runbooks.

Read [README.md](README.md) for the product model and deployment layout.

Read [e2e/README.md](e2e/README.md) before running browser tests.

## Working rules

Keep edits focused on the requested files and preserve unrelated work already present in the working tree.

Check `git status --short --branch` before editing and review the complete diff before committing.

Do not rewrite or delete untracked session, harness, or user files such as `.jcode/` and `.omo/`.

Match surrounding code and reuse existing tokens and primitives instead of creating parallel conventions.

For UI work, make the smallest coherent change and include the corresponding focused test or browser evidence when the repository already has a suitable seam.

Do not claim a UI is fixed from documentation alone.

Do not change issue or ticket statuses automatically because a pull request, branch, evidence link, or deployment event exists.

A commit, branch, or local verification run does not authorize a production deployment.

## Security and environment boundaries

Never commit `.env` files, generated environments, API keys, tokens, private keys, credentials, or service-account material.

Use `envkit run -- <command>` for local secrets, or `set -a; . "$(envkit path)"; set +a` inside a script, and never use `envkit get` or `envkit export`.

Use `api/.env.example` and `deploy/.env.example` as the documented variable names, and never inspect or copy `.env.local` values into source or documentation.

Keep e2e credentials and generated state in the ignored files described by [e2e/README.md](e2e/README.md).

The e2e suite uses a disposable local stack and a shared mutable database, so do not run separate Playwright invocations against the same stack concurrently.

Treat cleanup scripts that delete disposable test volumes as destructive and run them only when the disposable stack is no longer needed.

## Verified development commands

### Web

The web package scripts are defined in [web/package.json](web/package.json).

```bash
cd web
npm ci
npm run dev
npm run build
npm run lint
npm run test
npx tsc -b
```

`npm run dev` uses Vite on port 5173 and proxies `/api` and `/webhooks` to `http://localhost:8080`.

`npm run build` runs `tsc -b` and then `vite build`.

`npm run test` runs `vitest run` in the jsdom configuration from `web/vite.config.ts`.

### API

Run the API tests from [api/](api/).

```bash
cd api
go test ./...
```

The Go tests use Testcontainers, so Docker must be running.

For a local API without Compose, the verified README flow is:

```bash
cd api
DATABASE_URL=<postgres-url> go run ./cmd/ticket migrate
DATABASE_URL=<postgres-url> BASE_URL=http://localhost:5173 go run ./cmd/ticket serve
```

The SPA can then run from `web/` with `npm run dev`.

### Compose development

Use the local environment example and keep its values outside version control.

```bash
cd deploy
cp .env.example .env.local
# Fill .env.local in your own terminal.
docker compose --env-file .env.local up -d --build
curl -fsS http://localhost/api/v1/health
```

The Compose stack runs migrations before the API and worker and serves the built SPA through Caddy.

### Browser verification

The Playwright project and its real-stack web server behavior are defined in [e2e/playwright.config.ts](e2e/playwright.config.ts).

The standard e2e setup is documented in [e2e/README.md](e2e/README.md).

```bash
cd e2e
npm ci
npx playwright install chromium
env -u NO_COLOR npx playwright test
env -u NO_COLOR npx playwright test tests/onboarding.spec.ts
```

The Playwright suite uses Chromium, one worker, a shared disposable database, and the real Compose stack started by `./stack-up.sh`.

The default host port is 18399, and `E2E_PORT` can override it.

Do not run separate Playwright commands against the same running stack concurrently.

When the disposable stack is no longer needed, use its guarded cleanup command:

```bash
cd e2e
./stack-down.sh
node --test stack-safety.test.mjs
```

From the repository root, the guarded setup and localhost verification scripts are:

```bash
./deploy/verify-setup.sh
./deploy/verify-localhost.sh
node --test deploy/rollout.test.mjs e2e/stack-safety.test.mjs
```

These scripts leave the e2e stack running and do not authorize a production deployment.

## UI verification expectations

Read [design.md](design.md) and the relevant feature tests before changing a UI surface.

Use unit tests for component behavior, but use the real Playwright stack for routing, shell, responsive layout, data loading, and browser-visible workflows.

For issue-list work, run the focused web tests and [e2e/tests/issues.spec.ts](e2e/tests/issues.spec.ts), which covers workspace isolation, filtering, creation, navigation, desktop layout, and mobile containment.

For a changed page, verify at least 1280x900 and 390x844 because those are the issue-page browser viewports in the repository.

Check keyboard-only navigation, visible focus, reduced motion, both color schemes, loading, error, empty, no-results, saving, and destructive confirmation states.

### Screenshot checklist

- [ ] Desktop shell shows the sidebar, active navigation, workspace switcher, account menu, and command-palette entry.
- [ ] Mobile shell shows the workspace header, five-slot bottom navigation, safe-area spacing, and the More menu.
- [ ] The page has one clear heading and uses the shared max-width and spacing pattern.
- [ ] Issue rows stay dense and readable without a new card per issue.
- [ ] Long issue titles and metadata wrap without horizontal document overflow.
- [ ] Detail pages keep the narrative before the metadata rail on wide screens and preserve all content on narrow screens.
- [ ] Settings pages keep forms readable and destructive actions separated with explicit confirmation.
- [ ] Loading, error, empty, no-results, disabled, saving, focus, and keyboard states are visible and understandable.
- [ ] Screenshots at 1280x900 and 390x844 show no unintended horizontal overflow.
- [ ] Generated screenshots remain under ignored `e2e/test-results/` and are not committed unless a task explicitly changes a tracked visual artifact.

## Git identity and commits

Use the repository's configured NarayanaSabari identity for GitHub work and the `narayana` account for GitHub CLI operations.

Before committing, verify `git config user.name` and `git config user.email` in this repository.

The expected commit email is `sabarinarayanakg@proton.me`.

Commit only after inspecting the focused diff, checking the relevant validation evidence, and confirming that no secret or unrelated file is included.

Use a concise commit message with no tool attribution, co-author trailer, credentials, or session metadata.
