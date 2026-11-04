# desktop/src

## Overview

Source of the `velvet-desktop` binary: a native Rust/GPUI client for an existing Velvet server. `main.rs` parses flags and opens the window, `app.rs` owns the `Velvet` view and all UI state, and the remaining modules provide the HTTP client, Keychain storage, page builders, pure state helpers, theming, and the signed self-updater.

## Interface

- `main.rs`: `main` accepts `--server URL`, `--demo`, `--help`/`-h`. Unknown options and a missing `--server` value exit with code 2. Binds `cmd-q`, `cmd-k`, `cmd-n`, `cmd-r`, `alt-up`/`alt-down`, `escape`, `cmd-enter` and builds the Velvet, File, and View menus.
- `app.rs`: `Velvet` (view), `Velvet::new`, `check_for_updates`, `is_quitting`, `request_quit`, constant `DEFAULT_SERVER` (`https://velvet.sabarinarayana.com`), private `UPDATE_INTERVAL` (6 hours). Includes `ui_tests` (feature `ui-tests`).
- `api.rs`: `normalize_server`, `ApiClient` (`new`, `server`, `start_login`, `poll_login`, `identity`, `get_json`, `projects`, `issues_page`, `sprints`, `milestones`, `milestone_issues`, `issue`, `comments`, `add_comment`, `create_issue_in_project`, `update_issue`, `update_status`, `revoke`), data types `DeviceSession`, `Grant`, `Identity`, `User`, `Membership`, `Project`, `IssuePage`, `Issue`, `Sprint`, `Milestone`, `Comment`.
- `credentials.rs`: `load`, `save`, `delete` keyed by canonical server.
- `api.rs:User::label(&self) -> String` returns the display name unchanged unless it is blank after trimming, then falls back to email.
- `pages.rs`: `Page` (`title`, `from_nav`, `requests`, `build`), `Row`, `Section`, `describe_activity`.
- `state.rs`: `role_label`, `sprint_state_label`, `milestone_status_label`, `milestone_progress`, `visible_sprints`, `default_sprint`, `project_key`, `author_label`, `STATUSES`, `status_label`, `matching_indices`, `Revision` (`next`, `current`, `accepts`), `safe_external_url`.
- `theme.rs`: `Palette::new(dark)`, `apply(dark, cx)`.
- `update.rs`: `CURRENT`, `Manifest`, `signed_message`, `verify`, `check`, `running_bundle`, `download`, `check_writable`, `previous_failure`, `install_on_exit`, `encode_hex`, `decode_hex`, `auto_update_enabled`, `set_auto_update`.
- `update_swap.sh`: detached swap helper embedded via `update.rs:SWAP_SCRIPT`. Args: parent PID, transaction dir, target app, relaunch flag.

## Invariants

- `api.rs:normalize_server` accepts only HTTPS, or HTTP on loopback, and rejects credentials, query, or fragment. The result is both the request base and the Keychain account.
- `api.rs` is blocking and must be called from a worker thread, never the UI thread.
- `ApiClient::new` disables redirects (`redirect::Policy::none()`), with 10 s connect and 30 s total timeouts.
- `ApiClient::request` errors never expose transport details, URLs, or response bodies. `start_login`/`poll_login` do not send the saved bearer.
- `ApiClient::revoke` treats HTTP 401 as success and preserves other failures.
- `credentials.rs` stores tokens only in macOS Keychain (service `app.velvet.desktop`), rejects empty tokens, and fails on non-macOS.
- `state.rs:Revision::accepts` drops late responses after a context switch.
- `state.rs:safe_external_url` allows only `http`/`https` URLs with a host and no user info.
- `update.rs:check` ignores drafts, prereleases, and tags not prefixed `desktop-v` or not newer than `CURRENT`. A manifest is trusted only when `verify` passes the ed25519 check against `update-public-key.hex` over `signed_message` (`velvet-desktop:<version>:<sha256>`) and its version matches the release.
- `update.rs:client` is `https_only`. Archives are capped at `MAX_ARCHIVE` (200 MiB) and must carry bundle ID `app.velvet.desktop`.
- `update.rs:unique_dir` creates fresh `0700` directories and never reuses existing paths.
- `update.rs:install_on_exit` permits quit only after the helper writes `ready` within 3 s. On failure it removes the transaction and leaves the app open.
- `update_swap.sh` recovery depends on the failure stage. Before the old target moves, a failure may leave no `previous.app`. If installing the candidate fails, successful rollback moves `previous.app` back to the target, leaving the failure journal but no backup at that name. Failed rollback retains `previous.app` for manual recovery. Relaunch failure occurs after installation, so the new target stays installed and the backup remains; open the target manually. After installation succeeds, backup-removal failure may leave a backup, but transaction-cleanup failure can occur after that backup has already been deleted. Inspect the target and transaction directory rather than assuming a recovery bundle exists. Full success removes the transaction directory.
- Automatic updates default on. Only an explicit `off` in the prefs file disables them (`update.rs:auto_update_enabled`).

## Side Effects

- Network: Velvet server API via `reqwest` blocking client (`api.rs`). GitHub Releases API `api.github.com/repos/NarayanaSabari/velvet/releases` and asset downloads (`update.rs`).
- macOS Keychain reads, writes, and deletes (`credentials.rs`).
- Disk: `update.rs:download` stages under a private `velvet-update-*` dir in the system temp dir and runs `ditto -x`, `plutil`, `codesign --verify`. `~/Library/Application Support/Velvet/auto-update` (`update.rs:set_auto_update`). `.velvet-update-*` and `.velvet-probe-*` directories beside the app bundle (`update.rs`).
- Processes: `/usr/bin/ditto`, detached `/bin/sh` running `update_swap.sh`, which moves bundles and may run `open` to relaunch.
- Opens external URLs in the browser (`app.rs:open_web`).

## Verification

- Run: `cd desktop && cargo test --locked --features ui-tests -- --test-threads=1`
