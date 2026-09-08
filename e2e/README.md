# Browser integration tests

Run the production Compose services with a local GitHub provider:

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

The stack uses the disposable project `worklog-e2e-organisations`, HTTP port 18399, HTTPS port 18400, provider port 18599, and proxy subnet `172.30.77.0/24`.
Its fixed Caddy and API addresses are `172.30.77.2` and `172.30.77.3`; the API trusts only Caddy's `/32` for forwarded client IPs.
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
