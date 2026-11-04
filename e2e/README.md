# Browser integration tests

## Interface

| File | Purpose |
| --- | --- |
| `stack-common.sh` | Defines `E2E_PROJECT`, `E2E_PORT`, `E2E_PROVIDER_PORT`, `docker_local`, and `compose` (layers `../deploy/docker-compose.yml` with `compose.yml`). Executed directly, it forwards arguments to `compose`. |
| `stack-up.sh` | Generates env, builds and starts the stack, restarts stale Caddy, and polls `/api/v1/health` for up to 120 seconds. |
| `stack-down.sh` | Lists labelled containers and volumes, then runs `compose down -v`. |
| `stack-env.mjs` | Writes `.env.generated` (mode 0600) with disposable credentials and a fresh RSA App key. |
| `github-stub.mjs` | Local GitHub and TypeSafe provider double with `GET /test/stats`, `POST /test/control`, and authenticated `POST /v1/systemone`. |
| `compose.yml` | Test override for the production Compose file. |
| `playwright.config.ts` | Chromium, `workers: 1`, `baseURL` on `E2E_PORT`, real-stack `webServer`. |
| `tests/fixtures.ts` | `compose`, `sql`, `seedWorkspace`, `sprintProject`, `seedRepo`, `resetWorkspaceData`, `signWebhook`, `seededSessionToken`, `WEBHOOK_SECRET`, extended `test` with authenticated `request` and `signedIn`, `expect`. |
| `tests/onboarding-helpers.ts` | `unique`, `providerURL`, `mailLink`, `requestSignIn`, `signup`, `createOrganisation`, `invite`, `control`, `deliver`. |
| `tests/velvet-cli.ts` | `velvetBinary`, `linkedRepo`. |
| `stack-safety.test.mjs` | `node --test` guard regressions for the shell and fixture Compose boundaries. |

## Invariants

- Any `E2E_PROJECT` other than `worklog-e2e-organisations` exits before Docker is called.
- During environment generation, `stack-env.mjs` validates `E2E_PORT`, `E2E_PORT + 1` (HTTPS), and `E2E_PROVIDER_PORT` as integers between 1025 and 65535. Consequently the base `E2E_PORT` range is 1025 through 65534, while the provider port may reach 65535.
- Tests importing the extended `test` from `tests/fixtures.ts` receive an authenticated `request` fixture even without requesting `signedIn`. It seeds a session and creates an API context with `Cookie: ticket_session=<token>`, `Origin: baseURL`, and `Content-Type: application/json`, then disposes the context after use.

## Side effects

- `stack-up.sh` builds images and writes `.env.generated`. `stack-down.sh` deletes the project's volumes.

Run the production Compose services with a local GitHub and TypeSafe provider:

```bash
cd e2e
npm ci
npx playwright install chromium
env -u NO_COLOR npx playwright test
```

For the complete organisation signup, invitation, and installation journeys only:

```bash
env -u NO_COLOR npx playwright test tests/onboarding.spec.ts
```

For the login, terminal repository setup, scoped-command, and onboarding journeys:

```bash
env -u NO_COLOR npx playwright test tests/cli.spec.ts tests/agent-onboarding.spec.ts
```

The CLI suite builds the real binary and isolates credentials with `VELVET_NO_KEYCHAIN=1` in a private temporary directory.
It covers browser login consent, email sign-in return in a fresh tab, terminal organisation/project selection and creation, project scope, YAML tampering, and cascading logout revocation.
It also checks actual setup/derived-key labels and the cascading-revocation warning under Profile, with Cancel preserving all keys.
Consent screenshots cover 1280x900 and 390x844 in light and dark schemes with reduced motion and keyboard approval.
Generated screenshots remain under ignored `test-results/`.

The stack uses the disposable project `worklog-e2e-organisations`, HTTP port 18399, HTTPS port 18400, provider port 18599, and proxy subnet `172.30.77.0/24`.
Its fixed Caddy, API, and GitHub stub addresses are `172.30.77.2`, `172.30.77.3`, and `172.30.77.4`; the API trusts only Caddy's `/32` for forwarded client IPs.
Published ports bind only to `127.0.0.1`.
`E2E_PORT` and `E2E_PROVIDER_PORT` can override the host ports.
Other project names are rejected before Docker is called.
Every Docker invocation clears inherited service, `COMPOSE_*`, and `DOCKER_*` settings and targets the local daemon at `unix:///var/run/docker.sock`.
Remote Docker contexts are not supported by these disposable tests.
Check that the ports and subnet are available before starting a new stack.

`stack-up.sh` writes only `e2e/.env.generated`, with disposable credentials and a newly generated test App key.
This ignored file must never be committed.
The Compose override routes authorization, token exchange, and REST calls to the local Node provider and disables Resend delivery.
Emails appear in API logs; the onboarding helper selects links by unique recipient and action start time, preserving the fragment token.
The provider validates authorization state, client credentials, PKCE, and separate user/installation token use.
The same provider implements TypeSafe `POST /v1/systemone`, requiring `Authorization: Bearer e2e-typesafe-key`. It returns deterministic suggestion answers by matching words in work titles, bodies, and branches against candidate issue titles, with `none_of_these` when no words overlap. The Compose override sets API `TYPESAFE_CONFIGURED=true` and directs the worker to this local double with its test key, so suggestion workflows require no real TypeSafe credentials or external TypeSafe requests.
Its synthetic controls and diagnostic counters are available at `http://127.0.0.1:18599/test/stats`.
Tests inspect external GitHub settings links without following them.

The suite mutates its shared disposable database and runs with one worker.
Fixture resets clear test login tokens between spec runs so repeated local runs do not accumulate sign-in rate-limit counts; production limits remain unchanged.
Do not run separate Playwright invocations against the same stack concurrently.
Existing workflow specs clear shared evidence tables, so run the focused onboarding suite last when preserving an installation journey for manual inspection.
The stack remains running after tests; use `./stack-up.sh` to rebuild changed API or web code before rerunning against it.

Cleanup deletes this project's test database and other named volumes:

```bash
./stack-down.sh
```

The cleanup script displays the exact labelled containers and volumes before removal and rejects other project names.
Run its guard regressions with `node --test stack-safety.test.mjs`.
From the repository root, `./deploy/verify-setup.sh` and `./deploy/verify-localhost.sh` both run the focused onboarding suite through the same guarded stack boundary.
Both include signed webhook checks and leave the stack running; neither claims to test a webhook-free deployment.
Run `node --test deploy/rollout.test.mjs e2e/stack-safety.test.mjs` after generating the disposable environment to check deployment configuration and wrapper safety.
