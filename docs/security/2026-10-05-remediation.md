# Security remediation, October 5, 2026

## Scope and classification

The supplied `velvet-otter-lab_a6fb` report contains 12 formal findings.
The raw `dependency-cve-20ce5dc7` outputs add 12 distinct records: eight Go standard-library advisories, three additional Go module advisories, and one DOMPurify advisory.
The SARIF's other 29 entries are coverage notes, not 29 additional confirmed vulnerabilities.
Original scan artifacts are preserved and are not committed.
All reproductions use synthetic local data, not production accounts or repositories.

## Finding-by-finding disposition

| Original record | Change | Verification / exposure |
| --- | --- | --- |
| `vuln-0001`, CVE-2026-46603 / GO-2026-6222 | `golang.org/x/image` 0.38.0 → 0.45.0 | WebP is used by image uploads. Patched decoder is checked by Go vulnerability analysis and image integration tests. |
| `vuln-0002`, CVE-2026-46601 / GO-2026-5061 | Same image upgrade | WebP decoder panic advisory is absent from patched package analysis. |
| `vuln-0003`, CVE-2026-33813 / GO-2026-4961 | Same image upgrade | Patched dependency covers the 32-bit WebP advisory. Runtime checks here run on 64-bit hosts, not a 32-bit exploit replay. |
| `vuln-0004`, CVE-2026-33812 / GO-2026-4962 | Same image upgrade | SFNT is absent from the production dependency graph. |
| `vuln-0005`, CVE-2026-42500 / GO-2026-5031 | Same image upgrade | BMP is absent from the production dependency graph. |
| `vuln-0006`, CVE-2026-46599 / GO-2026-5032 | Same image upgrade | TIFF is absent from the production dependency graph. |
| `vuln-0007`, CVE-2026-46604 / GO-2026-5066 | Same image upgrade | TIFF is absent from the production dependency graph. |
| `vuln-0008`, CVE-2026-17106 / GO-2026-6253 | `github.com/moby/go-archive` 0.2.0 → 0.3.0 | Archive extraction is a Testcontainers dependency, absent from the production graph. Go tests still exercise the patched fixture infrastructure. |
| `vuln-0009`, CVE-2026-56854 / GO-2026-6303 | `golang.org/x/crypto` 0.54.0 → 0.56.0 | SSH is test-only, absent from the production graph. |
| `vuln-0010`, CVE-2026-56855 / GO-2026-6355 | Same crypto upgrade | Patched SSH advisory is absent from imported-package analysis including tests. |
| `vuln-0011`, CVE-2026-78662 / GO-2026-6354 | Same crypto upgrade | Same test-only classification and patched package check. |
| `vuln-0012`, writer-revocation TOCTOU | Current writer authorization is checked after acquiring the workspace transaction lock | Real HTTP requests authenticated before demotion/removal previously returned 200 and persisted an unauthorized title. Regression checks require 403 and unchanged stored data. |
| Raw CVE-2026-46602 / GO-2026-5062 | Image upgrade to 0.45.0 | TIFF tile allocation advisory is patched, TIFF remains unimported. |
| Raw GO-2026-5841 / GHSA-259r-337f-4rfw | `github.com/klauspost/compress` 1.18.6 → 1.18.7 | `compress/s2` is absent from both production and test package graphs. |
| Raw GO-2026-5932 | No unsafe OpenPGP dependency is introduced | No fixed release is available. `golang.org/x/crypto/openpgp` is absent from both package graphs. A module-only alert remains, not a reachable application vulnerability. |
| Raw GHSA-p98j-92pf-mc4p | DOMPurify 3.4.14 → 3.4.16 | The advisory's detached-node hook PoC retains `onerror` before the upgrade and removes it afterward for both hooks. Product Markdown uses string sanitization, not the vulnerable hook configuration. |
| Raw GO-2026-5026 / CVE-2026-39821 | Go toolchain 1.26.8 | Patched standard-library vendored IDNA code is checked by vulnerability analysis. |
| Raw GO-2026-5942 / CVE-2026-46600 | Same toolchain upgrade | Standard-library vendored DNS parser advisory is absent after upgrading. |
| Raw GO-2026-5972 / CVE-2026-33818 | Same toolchain upgrade | ASN.1 parser recursion advisory is absent after upgrading. |
| Raw GO-2026-6088 / CVE-2026-56859 | Same toolchain upgrade | XML parser recursion advisory is absent after upgrading. |
| Raw GO-2026-6089 / CVE-2026-56853 | Same toolchain upgrade | HTTP header-timeout advisory is absent after upgrading. |
| Raw GO-2026-6090 / CVE-2026-56862 | Same toolchain upgrade | TLS post-handshake resource advisory is absent after upgrading. |
| Raw GO-2026-6091 / CVE-2026-56858 | Same toolchain upgrade | HTML-template JavaScript context advisory is absent after upgrading. |
| Raw GO-2026-6218 / CVE-2026-56860 | Same toolchain upgrade | URL resolution complexity advisory is absent after upgrading. |

`api/go.mod`, the API Docker builder, and CI's Go selection use the same minimum Go 1.26.8 toolchain.
Required transitive `x/text` and `moby/sys/user` versions are refreshed by `go mod tidy`.
A fresh npm audit additionally found Undici advisories in web development dependencies and GHSA-82fw-gwwq-j7x9 in the MCP Vitest dependency.
The web lock now uses Undici 8.11.2, and MCP uses Vitest 5.0.3.
Web, MCP, and e2e npm audits report zero vulnerabilities.
CI runs Go imported-package/symbol vulnerability checks and web/MCP npm audits to detect regressions.

## Authorization behavior and concrete checks

The writer guard shares the workspace-first lock order used by membership administration.
It holds that lock through mutation and activity commit, denies nil, removed, and viewer actors, and rechecks role after lock acquisition.
Labels and manual PR link/unlink operations now authenticate a real actor inside their own transaction.
Manual PR attachment uses `LinkPRTx` in the same transaction rather than authorizing outside a second transaction.
Comment deletion reads the current role instead of trusting the role captured by HTTP middleware.
Image mutation locks use the same workspace-first order before membership and quota/grant locks.
Trusted worker operations remain separate and preserve their existing integration authorization.

| Changed public surface | Concrete check |
| --- | --- |
| Issues | `TestWriterRevocationInFlightHTTP` pauses a real authenticated HTTP body, revokes via actual administration routes, then checks 403 and the original title. |
| Comment, project, sprint, milestone, label and evidence creation | `TestWriterFamiliesRevocationInFlightHTTP` runs demotion and removal for each family, asserting 403, no inserted target/evidence rows, and no unauthorized activity rows. |
| All 24 distinct user mutation entrypoints | `TestUserWritersRejectRevokedAndNilActors` checks 24 cases covering 23 entrypoints for viewer, removed and nil actors. Image cases deliberately require denial before invalid-target/token validation. `TestImageConsumeRejectsRevokedWriter` separately consumes an actual grant after demotion/removal, checks `ErrUploadCredential`, and confirms zero images. Together these cover create/update/delete/promote, project mapping, sprint lifecycle, labels, evidence, and all image mutations. The matrix also checks preserved issue/comment content, sprint state, snapshot absence, PR links and labels. |
| Comment administrator privileges | `TestDeleteCommentRechecksAdminDemotedToMember` keeps another author's comment after an administrator loses that privilege. |
| Revocation arriving before mutation | `TestWriterRechecksAfterWorkspaceLock` observes an actual PostgreSQL lock waiter, commits demotion/removal, and confirms the queued mutation is denied. |
| Mutation arriving before revocation | `TestWriterLockSerializesAdminRevocation` observes the administrator waiting on the writer's transaction and confirms revocation only completes afterward. |
| HTTP permission errors | Shared mutation errors, project errors and sprint creation explicitly return 403 for `ErrForbidden`, not 500. Family regressions cover these paths. |
| Sanitizer advisory | `Markdown.test.tsx` repeats both after-sanitize hook PoCs and checks safe formatting plus dangerous attribute removal. |
| Stored issue descriptions and comments | `e2e/tests/security.spec.ts` writes hostile Markdown through the real API, opens the real SPA, checks inert scripts/events/links and preserves headings, safe links and task checkboxes at desktop and mobile sizes. |
| Image decoder and protected image workflows | Existing Go image tests and real `e2e/tests/images.spec.ts` cover valid upload/view/download/delete and malformed or unauthorized requests with the patched dependency. |
| Dependency packaging | Actual builds, tests, `govulncheck -test`, all npm audits, and disposable Compose verification validate the fixed dependency graph rather than a copied mock. |

## Reproduction and repeatable verification

The before-fix HTTP PoC returned 200 after both demotion and removal and stored `After revocation`.
The DOMPurify 3.4.14 hook PoC retained the event handler, while 3.4.16 removes it.
These are reproduced behavior changes, not just source inspection.
Go decoder and standard-library records are classified using upstream advisory version ranges and actual imported package graphs, not invented exploit results.

```bash
cd api
go build ./...
go vet ./...
go test -p 1 ./...
go test -p 1 -race ./internal/store ./internal/api -run 'Test(UserWriters|DeleteCommentRechecks|Writer|ImageConsume)' -count=1
go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 -test ./...

cd ../web
npm run build
npm run lint
timeout 180 npx vitest run --maxWorkers=2 < /dev/null
npm audit --audit-level=low

cd ../mcp
npm run build
npm test
npm audit --audit-level=low

cd ../e2e
npm audit --audit-level=low
./stack-up.sh
env -u NO_COLOR npx playwright test

cd ..
python3 cli/test_upload_image.py
```

Never run separate Playwright invocations concurrently against the shared disposable stack.
Do not run a source scan in the user's mutable checkout.
Any focused Strix retest belongs in a disposable checkout with synthetic local data, using the existing subscription route, not a managed-cloud upload.
A clean scoped scan is evidence about its analyzed scope, not proof that the entire application has no vulnerabilities.

## Validation status

Patched web validation passes build, lint with the baseline 16 warnings, and all 288 local unit tests including one untouched untracked probe test.
MCP build and 40 tests, CLI's three transport tests, and all three npm audits pass.
The actual fixed API checkout passes full build, vet, all Go tests and focused race tests.
Its final `govulncheck -test` reports zero affected symbols and zero vulnerable imported packages, with only the unimported OpenPGP module alert.
The actual production and test package graphs contain zero OpenPGP imports.
A rebuilt disposable Compose stack passes all six focused image/Markdown browser cases, including desktop/mobile stored-content safety and JPEG/WebP viewing, downloading and removal.
The complete 90-case browser suite and all 16 deployment/stack safety checks pass.
Pull-request checks validate the submitted branch independently of these local results.
A supplementary focused source retest runs in a clean disposable checkout of the fixed production code, never in the user's checkout or against production.
Its result and any environment limitations are recorded separately and do not replace the actual API, browser and dependency checks above.
No migration, production configuration change, deployment, credential rotation, or deletion of original reports is part of this change.
