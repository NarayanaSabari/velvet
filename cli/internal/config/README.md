# config

## Overview
Package `config` finds a repository's `velvet.yaml` and the credential that goes with it. It also owns private directory bindings, setup logins, management logins, and descendant project-key tracking.

`velvet.yaml` is not a security boundary. The private canonical-directory binding controls cached credential selection.

## Interface
- `config.go:FileName` (`velvet.yaml`), `Link{Server, Organisation, Project}`, `Repo{Link, Path}`.
- `config.go:Link.Validate`, `Link.ServerURL`, `Find(dir)`, `Write(dir, link)`.
- `config.go:Keys{Dir, NoKeychain}` with `Save`, `Load`, `LoadStored`, `Delete`.
- `config.go:ErrNotInitialised`, `ErrNoKey`.
- `setup.go:ValidateServer`, `Keys.SaveLogin`, `Keys.Login`, `Keys.DeleteLogin`, `ErrNoLogin`.
- `setup.go:Keys.Binding`, `Keys.Bind`, `Keys.Unbind`, `Keys.CheckBinding`, `SameLink`, `Keys.LinkDirectory`.
- `binding.go:Keys.HasBinding`.
- `descendants.go:Keys.TrackProject` records SHA-256 hashes (`tokenHash`) of project keys issued under a machine login.
- `management.go:Keys.SaveManagement`, `Keys.Management`, `Keys.DeleteManagement`, `ErrNoManagement`.
- `lock_unix.go` / `lock_windows.go:lockCredentialsFile` (platform-specific file lock).

## Invariants
- `Link.Validate` accepts only an http(s) server URL with host, an empty path or `/`, and no user, query (including a bare `?`), fragment, opaque URL, or encoded raw path, an organisation matching `slugRe`, and a project matching `keyRe`. `Link.ServerURL` strips trailing slashes. `Find` and `Write` validate before use.
- `Find` walks up from the directory to the nearest `velvet.yaml`.
- `Write` and `LinkDirectory` use `atomicWrite` (temp file, fsync, rename).
- `LinkDirectory` rolls YAML back if `Bind` fails. Credentials must be stored before it is called.
- Bindings key on the canonical path from `filepath.EvalSymlinks`, so symlink aliases share one binding (`bindingLink`).
- `CheckBinding` checks every ancestor and fails when the nearest binding differs from YAML. Its doc comment requires that no project credential be selected or sent before it succeeds. Callers enforce this (`cmd/velvet/main.go:loadEnv`).
- `Keys.Load` lets `VELVET_TOKEN` override stored keys. `VELVET_NO_KEYCHAIN` or `NoKeychain` forces the file store.
- Setup (`@setup`), active (`@active`), descendants (`@descendants`), directory (`@directory:`), and management entries use separate synthetic `Link` names, so they never collide with project keys.

## Side Effects
- Reads and writes `velvet.yaml` (mode 0644).
- Reads and writes the OS keychain through `github.com/zalando/go-keyring` under service `velvet`.
- Fallback store: `credentials.json` in the user config dir, directory mode 0700, file 0600, guarded by an exclusive `.lock` file lock.

## Verification
- Run: `go test ./internal/config/...` from `cli/`.
