# CLI instructions

Read the repository root `AGENTS.md` and this directory's `README.md` before changing CLI behavior.

- Keep browser consent in `velvet login`. `velvet init` must remain terminal-only and write YAML in the invocation directory.
- Setup credentials may only call identity and organisation/project setup APIs. Work commands must verify `/me` reports `token_kind: project` and the exact YAML scope.
- Account-wide commands live under `velvet admin` and require separate explicit browser management consent. Never load management credentials from YAML, setup storage, project keys, or `VELVET_TOKEN`. Resolve the server only from an explicit flag, trusted `VELVET_SERVER`, or the hosted default. Verify personal token kind and account identity before any administration request.
- Management logout revokes only its own account credential. Normal logout revokes setup and derived project keys, not separately approved management access. Destructive account operations and sprint activation/completion require explicit `--yes`.
- Reports and mentions invoked outside `admin` use only repository credentials and must be filtered by the API to that exact project.
- Never use editable YAML to choose a machine setup credential. Login/logout and explicit account identity use `--server`, `VELVET_SERVER`, or the default server.
- Cached project credentials require a private canonical-directory binding established by confirmed init. An edited YAML file must not select another cached key.
- Unbound CI may use `VELVET_TOKEN` only after pinning the YAML server to trusted `VELVET_SERVER` (or the hosted default) and verifying token kind and scope. Never permit personal or setup token bypasses.
- Preserve existing three-field YAML and project credentials. Confirm migration through init, without requiring browser login for a still-valid legacy project key.
- Keep configuration writes atomic. On failure, restore local state, attempt to revoke newly issued credentials, and report failed rollback or server revocation accurately.
- Logout revokes machine setup and descendants before local deletion. Clear only matching tracked credentials, preserving other accounts, servers, YAML, and bindings.
- Never print, commit, or include credentials in YAML, errors, or test artifacts. Private storage belongs to the OS keychain or a 0600 user-config file, never the repository.
- Unit tests must isolate `HOME`, `XDG_CONFIG_HOME`, and `APPDATA`, force `VELVET_NO_KEYCHAIN=1`, and use fake secrets. Do not touch a developer's keychain.

Run from `cli/`:

```bash
go test -race ./...
go vet ./...
go build ./cmd/velvet
```

The real browser workflow is covered by `e2e/tests/cli.spec.ts` and `e2e/tests/agent-onboarding.spec.ts`. Follow `e2e/README.md`, and never run separate Playwright commands against the same disposable stack concurrently.
