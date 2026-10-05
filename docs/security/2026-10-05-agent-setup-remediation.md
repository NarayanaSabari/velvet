# Agent setup and local image upload security, October 5, 2026

## Scope

The `velvet-otter-lab_5e33` report contains one confirmed Medium finding, `vuln-0001`, not four confirmed vulnerabilities.
Its local-file approval concern and unavailable runtime checks are follow-ups, while unfinished scan coverage remains a limitation.
Original reports are preserved outside version control.
This change removes the unsafe generated bridge, hardens the local image tool, and runs the real application's existing checks without changing production credentials or deployments.

## Changes and requirement-to-check evidence

| Concern / public output | Change | Concrete verification |
| --- | --- | --- |
| Other setup executes an unpinned helper with a token | Generated configuration now uses native remote HTTP URL and authorization header, with no executable, arguments, or automatic download. | The real onboarding regression failed before the fix with `command: "npx"`. Both onboarding and Profile now connect using exactly the rendered Other configuration and observe agent connection. Onboarding creates a ticket and worklog through the real hosted MCP API. |
| Compatibility with stdio-only clients | Guidance points to the existing first-party local MCP server and secret-manager environment configuration rather than silently installing a bridge. | Snippet unit tests assert native HTTP shape and private-config/stdio guidance. Real desktop and mobile Profile screenshots show readable guidance without horizontal overflow. Existing four client snippets are unchanged. |
| Local file transmission without an exact approval gate | Every local image tool call requests form elicitation for the absolute path, established workspace, destination URL, and caption before file access or network. | Actual installed SDK Client/Server negotiation checks strict accepted `confirm: true`, no default, fresh confirmation per call, and ignores a model-supplied approval argument. Real stdio subprocess acceptance validates the same wire prompt and saves an image visible in the portal. |
| Unsupported, denied, pending, malformed, or failed approval | No file access or HTTP is allowed. Manual CLI guidance explicitly asks the user, never an automatic fallback. | SDK tests observe zero metadata/open/fetch calls for missing and URL-only capabilities, decline, cancel, false, missing or invalid confirmation, missing/erroring handler, pending request, timeout, and cancellation. Real stdio denied/unsupported calls leave actual API attachments and issue status unchanged. |
| Exact destination and first-upload discovery | Upload requires `VELVET_WORKSPACE` or an earlier `velvet_where_am_i` result. Upload itself does not discover a namespace before consent. | SDK tests reject an unresolved destination with zero file/network calls, support prior repository discovery, and reject a namespace changed during confirmation. Read-only tools still work without elicitation. |
| Ordinary non-image files sent before server validation | A bounded post-consent read requires exact PNG, JPEG, or WebP signature bytes before multipart construction or transport. API decoding and sanitization remain authoritative. | SDK and file tests reject synthetic non-image content and high-bit WebP signature spoofing without POST. Real stdio uploads preserve browser-encoded PNG, JPEG, and WebP files visible on ticket or milestone pages. |
| Cancellation after approval | The tool signal propagates through bounded reads and upload fetch, with file handles closed. | Actual SDK cancellation tests pause a real file read, cancel the call, then observe one read, handle closure, and zero POST. A pending transport test observes the same signal aborted with no retry. |
| Previously unavailable backend/browser verification | Use the actual project and disposable database/Compose stack, not a copied application. | Full Go build, vet, tests and focused race checks pass. Full web tests/build/lint/audit pass. The final MCP/CLI/browser/stack gate is recorded below. |

The accepted stdio workflow covers both an issue and a milestone, with portal reload persistence and unchanged issue status.
Hosted image transfer, protected viewing/downloading, explicit deletion, viewer restrictions, and CLI uploads remain covered by the same real browser suite.
Preflight retains final-symlink, regular-file, inode, size, growth, and bounded-read checks.
File tests exercise final symlinks, directories, missing/empty/oversize files, blank captions, signature filtering, and cancellation.

## Repeatable verification

```bash
cd web
npx vitest run --maxWorkers=2
npm run build
npm run lint
npm audit --audit-level=low

cd ../mcp
npm run build
npm test -- --reporter=verbose
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --strict --skipLibCheck tests/image-tools.test.ts tests/images.test.ts
npm audit --audit-level=low

cd ..
python3 cli/test_upload_image.py
cd e2e
npm audit --audit-level=low
./stack-up.sh
env -u NO_COLOR npx playwright test
cd ..
node --test deploy/rollout.test.mjs e2e/stack-safety.test.mjs

cd api
go build -p 1 ./...
go vet -p 1 ./...
go test -p 1 ./... -count=1
go test -p 1 -race ./internal/store ./internal/api -run 'Test(UserWriters|Writer|ImageConsumeRejectsRevokedWriter|Security|NonMember|InviteAcceptanceNeverDepends|EffectiveGitHubIdentity)' -count=1
go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
```

Run browser invocations serially, and do not run competing Testcontainers suites against the shared disposable stack.
Do not delete the stack or its volumes as part of verification.
Generated screenshots and synthetic credentials stay in ignored test artifacts.

## Validation status

The unsafe Other setup was reproduced through actual onboarding before changing it.
The fixed onboarding/Profile browser suite passes all four cases, including desktop 1280x900 light and mobile 390x844 dark/reduced-motion containment.
The focused image suite passes all five cases through actual CLI/stdio/hosted API and portal pages.
Full web validation passes 293 tests in 33 files, including one untouched untracked probe test, build, lint with the baseline 16 warnings and no errors, and a zero-vulnerability npm audit.
Full backend build, vet, tests, and focused race checks pass on Go 1.26.8.
Go vulnerability analysis reports zero affected symbols and zero vulnerable imported packages, with one required-module advisory in unused OpenPGP code.
Final integrated validation passes MCP build and all 74 tests, explicit typechecking of changed MCP tests, CLI's three transport tests, all 92 real browser cases, and all 16 deployment/stack safety checks.
MCP and e2e npm audits also report zero vulnerabilities.
The initial full browser run exposed two attribution queries matching old rows with the same issue/project key in another organisation.
Adding the test organisation to those queries preserves the assertion and passes the complete repeated run without deleting prior fixtures.
Independent source review confirms the cancellation issue is closed and found no additional concrete security blocker.

## Compatibility and limits

Replace previously copied Other configurations that invoke `npx mcp-remote`; this source change does not edit clients already configured or automatically revoke their tokens.
Token-bearing native client configuration remains private and must not be committed.
The first-party stdio server must be rebuilt to receive the new image gate.
Clients without form elicitation can still use read-only tools, but cannot automatically upload local images through this tool.
Legacy empty elicitation capability is normalized by the installed SDK and tested.
A host must present the request to the user rather than automatically accepting it; a protocol response is not independent proof of human review.
Approval concerns the path and destination, not an immutable pre-approval file snapshot or a trusted user-file picker.
The lightweight signature check is not a decoder and does not replace API image validation.
An already pending filesystem operation may finish after cancellation, and aborting an in-flight upload cannot undo a request already committed by the API.
Check the target's attachments before retrying an interrupted upload.
Hosted upload preparation, terminal HTTP transfers, and CLI commands remain governed by their own host approval policies, not this local stdio elicitation gate.
Tests establish these changed workflows, not a complete new penetration test or validation of every third-party host's approval UI.
The original scan's unfinished coverage and absent source revision remain limitations of that report.
No merge, production deployment, credential rotation, schema change, or deletion of reports is included in this task.
