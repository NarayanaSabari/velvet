# README Contract Drift Report

Date: 2026-11-04

Remediation status: Complete for all **70/70 reported findings**, with no unresolved item in the reviewed scope. Each checked finding below retains the original review text and is marked resolved after documentation correction and independent source recheck. Two additional API wording caveats found during verification were also corrected and rechecked. Changes are documentation-only, unstaged, and uncommitted.

### Remediation verification

- Root and infrastructure: **9/9 findings independently rechecked and resolved** in `README.md`, `deploy/README.md`, and `e2e/README.md`. The manual upgrade now builds or pulls before stopping writers and uses an explicit successful one-shot migration before restart. Sources: `deploy/docker-compose.yml`, `api/internal/db/migrate.go`, `cli/cmd/velvet/main.go:recap`, `.github/workflows/ci.yml`, `deploy/remote-deploy.sh`, `deploy/backup.sh`, `e2e/github-stub.mjs`, `e2e/stack-env.mjs`, and `e2e/tests/fixtures.ts`.
- CLI and desktop: **11/11 findings independently rechecked and resolved** across six contracts. Checks covered init binding/relink paths, logout's early return, fallback-file versus Keychain identifiers, `--owner`, URL normalization, self-update's separate HTTP client, updater recovery stages, `User::label`, manual update checks, scoped release cleanliness, and retained `dist/.previous.*` bundles. Sources: `cli/cmd/velvet/{init,login,planning,update}.go`, `cli/internal/config/config.go`, `desktop/src/{api,app,main}.rs`, `desktop/src/update_swap.sh`, and `desktop/release.sh`. Existing broad source comments were not edited or treated as executable guarantees.
- Web: **28/28 findings independently rechecked and resolved**. Checks covered shell access/SSE, infinite queries, admin/destructive guards, consent modes and session isolation, callback signatures, exact image URLs, invalidation exceptions, pagination, browser/clipboard effects, token lifetime, query keys, optimistic board rollback, link reconciliation, redirects, and Markdown/Mermaid trust boundaries. Sources are the production files cited in each web finding below. Static review does not prove runtime security, secret erasure, or concurrent mutation behavior.
- API: **22/22 original findings independently rechecked and resolved** across twelve contracts. The Store inventory covers all 157 exported Store methods and 31 package functions, with `TokenScope.Scoped` separately documented. Concrete route registration coverage agrees with production source. Checks covered security exemptions, consent results, cookie flags, schema constraints, limits, cleanup, retries, provider authentication, decoding, and worker attribution. Behavioral descriptions were inspected selectively, not exhaustively for every inventoried symbol.
- Follow-up precision: cache-header documentation now distinguishes successful or decoded handler paths from early errors. TypeSafe documentation distinguishes answer-key/JSON decoding checks from semantic validation, including accepted zero-valued `null` or `{}` answers. Sources: `api/internal/api/cli_auth.go`, `api/internal/api/worklog.go`, and `api/internal/typesafe/client.go`.
- Validation: `node --test deploy/rollout.test.mjs e2e/stack-safety.test.mjs` passed, 20 tests. All 59 README files passed 374 relative-link target checks, balanced code-fence checks, and `git diff --check`; original web template notes remain unchanged. No deployment or destructive stack operation ran. No functional source file changed, and nothing was staged or committed. Velvet work logging could not proceed because the server login is unavailable; no entry was written.

Scope: 59 README contracts created or updated during the repository bootstrap, including pre-existing text in modified files. Findings compare documentation with the current working-tree source. All 59 documents have a section below. Sections are grouped by review partition.

Original review result: 70 findings across 41 documents. Eighteen documents had no detected drift. Findings included false claims and missing interface, invariant, or side-effect coverage. Severity refers to documentation risk, not a confirmed runtime vulnerability. The highest-priority finding was the unsafe manual migration/upgrade sequence in the root README. The original finding text below is retained as historical evidence, not a description of the corrected contracts.

Limitations: The original review and independent remediation checks used fresh reviewers and bounded static source inspection. Deep HTTP/store implementation coverage and other large source areas were sampled, not exhaustively verified line by line. No drift detected does not prove complete coverage or runtime correctness. The original review ran no tests and made no fixes; remediation changed documentation and ran only the safety tests listed above. Live authentication, updater execution, browser workflows, external providers, hosted settings, deployed schema state, and production rollout remain unverified. Test-only directories were intentionally excluded by the bootstrap policy, not treated as missing contracts.

## README.md

- [x] **High: Unsafe manual upgrade sequence.** Lines 570–578 run `compose up` without first stopping writers, despite the earlier migration safety warning. `deploy/remote-deploy.sh:59–66` stops `api` and `worker` before migration because migration 0020 changes writer compatibility. Update the manual sequence to preserve that boundary.
- [x] **Medium: CLI recap scope is unclear.** The example near lines 182–191 leads into account-wide work-log coverage, but `cli/cmd/velvet/main.go:340–351` supplies workspace and project filters. `api/internal/api/worklog.go:83–95` enforces project-key scope. Distinguish the project-scoped CLI recap from the account-wide web/API view.
- [x] **Low: Subcommand count is stale.** The Layout section says three commands and omits `eval-suggestions`. `api/cmd/ticket/main.go:35–37,104–108` exposes four commands.
- [x] **Low: CI suite count is stale.** The test guidance refers to three suites and the other two. `.github/workflows/ci.yml:86–103` includes a separate CLI suite, and the e2e job depends on API, web, and CLI jobs.

## deploy/README.md

- [x] **Medium: Deployment side effects omit host-wide image pruning and a marker write.** `deploy/remote-deploy.sh:77–82` prunes dangling images older than 168 hours without a Compose-project restriction and writes `.deployed-tag` after health succeeds. Include both effects.
- [x] **Medium: Backup trust and upload boundaries are missing.** `deploy/backup.sh:8–13` executes `ENV_FILE` as shell input. Lines 40–42 optionally upload the dump with `aws s3 cp` when `BACKUP_S3_URL` is set. Document the trusted-file requirement, external destination, and AWS CLI dependency.

## e2e/README.md

- [x] **Medium: Provider interface coverage omits TypeSafe.** `e2e/github-stub.mjs:43–71` implements authenticated `POST /v1/systemone` with deterministic word-overlap answers. `e2e/compose.yml:24,28–34` enables suggestion reporting and directs the worker to that double. The contract describes only the GitHub interface.
- [x] **Medium: Fixture coverage omits the authenticated request override.** `e2e/tests/fixtures.ts:138–149` seeds a session and injects Cookie, Origin, and JSON headers into `request`. Tests importing this extended `test` receive authenticated API requests without requesting `signedIn`.
- [x] **Low: Port bounds need qualification.** `e2e/stack-env.mjs:4–6` validates `E2E_PORT + 1`, so the maximum base port is 65534, not 65535. The provider port maximum is 65535. Validation happens during environment generation.

## plugins/README.md

No drift detected.

## plugins/velvet/README.md

No drift detected.

## cli/cmd/README.md

No drift detected.

## cli/cmd/velvet/README.md

- [x] **Medium: Authentication flow qualification is wrong.** The contract says init bypasses `CheckBinding` and logout uses `setupIdentity`. Init checks bindings unless relinking is explicitly confirmed (`cli/cmd/velvet/init.go:139–166`). Logout revokes and returns before `setupIdentity` (`cli/cmd/velvet/login.go:254–267`).

## cli/internal/README.md

No drift detected.

## cli/internal/client/README.md

- [x] **Low: Client ownership is overstated.** Not every command uses this client. Self-update uses `downloadClient` and `fetch`, with distinct timeout and redirect rules (`cli/cmd/velvet/update.go:23–35,93–103`).

## cli/internal/config/README.md

- [x] **Low: Server URL path restriction is overstated.** Validation accepts `/` as well as an empty path, and `ServerURL` strips trailing slashes (`cli/internal/config/config.go:62–79`).

## desktop/examples/README.md

No drift detected.

## desktop/src/README.md

- [x] **Medium: Recovery retention promise is too broad.** The updater does not retain `previous.app` on every failure. Successful rollback moves it back to the target, early failures may create no backup, and transaction cleanup can fail after backup deletion (`desktop/src/update_swap.sh:13–18,28–35,46–49`). Describe recovery by failure stage.
- [x] **Low: Public interface omission.** `User::label` chooses a display name or email fallback but is absent from the inventory (`desktop/src/api.rs:378–386`).

## cli/README.md

- [x] **Medium: Authentication flow qualification is wrong.** The appended invariant says init bypasses `CheckBinding` and logout uses `setupIdentity`. Init checks bindings except confirmed relinking (`cli/cmd/velvet/init.go:139–166`), and logout returns after revocation and cleanup before the identity call (`cli/cmd/velvet/login.go:254–267`).
- [x] **Medium: Credential identifier hashing needs a storage qualifier.** Keychain entry identifiers use unhashed `account(p)` identifiers. Only fallback-file identifiers use `fileKey` hashing (`cli/internal/config/config.go:122–125,235–245,269–279`).
- [x] **Low: Milestone edit flag omitted.** `--owner UUID|none` sets or clears `owner_id` but is absent from the command reference (`cli/cmd/velvet/planning.go:117–119,157–163`).

## desktop/README.md

- [x] **Medium: Unbundled update-check claim is too broad.** Automatic startup checks require an app bundle, but the manual menu action invokes `check_for_updates` and calls GitHub without that guard. Installation is separately guarded (`desktop/src/main.rs:60–62`; `desktop/src/app.rs:219–234,249–258,282–289`).
- [x] **Low: Release clean-tree boundary is narrower than documented.** The release check covers only the desktop subtree, excluding `dist` and `target`, not the whole repository (`desktop/release.sh:16–24`).
- [x] **Medium: Release filesystem side effect omitted.** Before packaging, an existing `dist/Velvet.app` moves into a new `dist/.previous.*` directory. The script has no cleanup step for that retained directory (`desktop/release.sh:27–44`).

## api/README.md

No drift detected.

## api/cmd/README.md

No drift detected.

## api/cmd/ticket/README.md

No drift detected.

## api/internal/README.md

No drift detected.

## api/internal/api/README.md

- [x] **Medium, incorrect Origin invariant:** Cookie/browser requests do not universally require Origin. Middleware exempts GET, HEAD, OPTIONS, webhook requests, and the two CLI device endpoints. Checked browser mutations also require JSON, except supported image multipart requests. Source: `api/internal/api/browser_security.go:12-37,45-51` (`browserMutations`, `cliDeviceRequest`).
- [x] **Medium, missing exported interfaces:** The interface omits `CurrentUser`, `CurrentWorkspace`, `RequireAuth`, `RequireWorkspace`, `RequireRole`, `RequestID`, `Logging`, `Recover`, `DecodeJSON`, `ErrorResponse`, `ErrorBody`, and `RenderWorklogMarkdown`. `DecodeJSON` rejects unknown fields and reads through a 1 MiB limit. Sources: `api/internal/api/auth.go:28-35,125-270,314-329`, `api/internal/api/middleware.go:16-28,43-72`, `api/internal/api/respond.go:12-19,36-53`, `api/internal/api/worklog.go:134` (`RenderWorklogMarkdown`).
- [x] **Medium, missing HTTP interface coverage:** Private registration-function names replace concrete route and payload contracts. Existing interfaces include CLI consent flows `init|login|manage|desktop`, polling outcomes, comment promotion, mentions, repository resolution, and JSON/Markdown worklogs. These are not individually documented. Sources: `api/internal/api/cli_auth.go:14-56,60-85` (`registerCLIAuthRoutes`, create/collect handlers), `api/internal/api/comment.go:15-36` (`registerCommentRoutes`), `api/internal/api/worklog.go:15-18` (`registerWorklogRoutes`).

## api/internal/auth/README.md

- [x] **Medium, missing cookie security contract:** Both helpers set `Path=/`, `HttpOnly=true`, `SameSite=Lax`, and the supplied `Secure` flag. Clearing uses `MaxAge=-1`. Only lifetime is documented. Source: `api/internal/auth/session.go:13-34` (`SetSessionCookie`, `ClearSessionCookie`).

## api/internal/config/README.md

- [x] **Medium, missing load-time rejection rules:** `Load` requires `DATABASE_URL` and rejects malformed proxy CIDRs, `/0` prefixes, and IPv4-mapped IPv6 prefixes. Accepted prefixes are masked. These failures affect every subcommand, unlike serve-only URL/mail validation. Source: `api/internal/config/config.go:69-82` (`Load`).

## api/internal/db/README.md

- [x] **Low, missing connection behavior:** `Connect` overrides the parsed configuration to ten connections and one-hour connection lifetime. It immediately pings and closes the pool on ping failure. Source: `api/internal/db/db.go:11-27` (`Connect`).
- [x] **Medium, missing schema invariants/enums:** The table inventory omits enforced domain contracts, including issue-status values, priority `0..4`, one-level issue nesting, one active sprint per project, credential kinds, CLI flow values, and repository-scoped commit identity. Sources: `api/internal/db/migrations/0001_init.sql:79-125` (`issue_status`, `issue`, `issue_depth_guard`), `api/internal/db/migrations/0011_sprint_project.sql:40-45` (`sprint_single_active_idx`), `api/internal/db/migrations/0019_desktop_auth.sql:4-11` (credential/flow constraints), `api/internal/db/migrations/0020_repo_scoped_commits.sql:3-4` (`commit_ref` primary key).

## api/internal/fracdex/README.md

- [x] **Low, incomplete failure contract:** `ErrOutOfOrder` also covers characters outside the alphabet. Valid ordering alone does not guarantee a key: generation stops after 64 iterations with `ErrTooDeep`. Sources: `api/internal/fracdex/fracdex.go:11-17,35-48,55-77` (`maxLen`, `Between`).

## api/internal/github/README.md

- [x] **Medium, incorrect App authentication invariant:** Not every App call exchanges an App JWT for an installation token. `InstallationSuspended` sends the App JWT directly because suspended installations cannot mint installation tokens. Source: `api/internal/github/installation.go:15-27` (`InstallationSuspended`).
- [x] **Medium, incomplete authorization rule:** Installation verification requires more than an installation “belonging to the user.” Personal installations require matching account ID. Organisation installations require active organisation-admin membership. Candidate `0` skips installation verification and returns identity only. Source: `api/internal/github/user_auth.go:87-98,147-193` (`Authorize`, `verifyInstallation`).

## api/internal/imageupload/README.md

- [x] **Medium, missing supported-format restriction:** PNG/JPEG/WebP acceptance does not include animated PNG or WebP. APNG animation chunks and WebP `ANIM`/`ANMF` return `ErrInvalid`. WebP also requires exactly one frame and matching canvas/frame dimensions. Source: `api/internal/imageupload/image.go:178-179,341-345,375-381` (`stripPNG`, `stripWebP`).

## api/internal/linker/README.md

- [x] **Low, incomplete result/closing contract:** Closing-word detection applies only to title/body, not branch matches. Title matches use source `"body"`. Keys normalize to uppercase, and later closing matches upgrade `Closing` while preserving the first source. Source: `api/internal/linker/linker.go:33-54` (`Find`).

## api/internal/mail/README.md

- [x] **Low, inaccurate network guarantee and missing bound:** HTTPS is the default, not enforced. `NewResend` accepts an override URL, and `Send` posts to it. Each send applies a two-second context timeout even with a supplied HTTP client. Source: `api/internal/mail/resend.go:13-15,24-37,49-55` (`NewResend`, `Send`).

## api/internal/store/README.md

- [x] **Medium, incorrect cleanup invariant:** Expired session cleanup is not batched. `DeleteExpiredSessions` deletes every expired session in one statement. The 1,000-row bounds apply to other authentication cleanup queries. Source: `api/internal/store/session.go:33-40,43-65` (`DeleteExpiredSessions`, `CleanupExpiredAuthentication`).
- [x] **Medium, overstated sprint-name validation:** `CreateSprint` inserts the supplied name without checking emptiness. The schema requires only non-NULL text. Nonblank-name validation exists in `UpdateSprint`, not creation. Sources: `api/internal/store/sprint.go:68-71,96-109` (`UpdateSprint`, `CreateSprint`), `api/internal/db/migrations/0001_init.sql:47-56` (`sprint`).
- [x] **Medium, missing public interface coverage:** The stated **157 exported `*Store` methods across 31 files** matches source, but domain names do not document those interfaces. Package-level APIs are also absent, including `RecordActivity`, `ValidIssueStatus`, `ValidCommentTarget`, `ValidCommentKind`, `NormalizeEmail`, `NormalizeIP`, `ValidLoginReturnTo`, and workspace transaction guards. Sources: `api/internal/store/activity.go:37-79`, `api/internal/store/issue.go:38-91`, `api/internal/store/comment.go:35-62`, `api/internal/store/login_token.go:25-52`, `api/internal/store/workspace.go:74-103`.
- [x] **Medium, missing transactional side effects:** Sprint activation completes the previous active sprint in that project. Closing captures a snapshot before rolling incomplete issues forward and records activity in the same transaction. These effects are absent from the contract. Source: `api/internal/store/sprint.go:157-194,197-234` (`ActivateSprint`, `CloseSprint`, `closeSprintTx`).
- [x] **Medium, missing limits and retry policy:** The unnamed organisation image quota is **512 MiB**. API-token issuance caps users at **20 tokens**. Failed jobs dead-letter at attempt **5**, with exponential retry delay capped at one hour. Sources: `api/internal/store/image.go:15-17,126-135` (`ImageQuotaBytes`, `insertImage`), `api/internal/store/api_token.go:14-19,87-99` (`createAPITokenTx`), `api/internal/store/job.go:12-15,80-90` (`FailJob`).

## api/internal/typesafe/README.md

- [x] **Medium, missing request/error contract:** The client posts to `/v1/systemone`, uses a 20-second HTTP timeout, reads at most 1 MiB, and requires every requested answer. HTTP `401/403` maps to `ErrUnauthorized`, `400/413/422` to `ErrRejected`, and other non-200 statuses to `APIError`. Source: `api/internal/typesafe/client.go:24-30,119-175` (`Choices`).

## api/internal/worker/README.md

- [x] **Medium, overstated nil-GitHub behavior:** A nil GitHub client does not universally disable GitHub work harmlessly. Current installation-sync jobs record failure and retry. A review lacking its mirrored PR also fails without GitHub. Sources: `api/internal/worker/installation.go:43-59,74-90` (`syncInstallationState`, `syncInstallationRepos`), `api/internal/worker/review.go:41-49` (`syncReview`), `api/internal/worker/worker.go:122-128` (`ProcessOnce`).
- [x] **Medium, incorrect rejection backoff rule:** TypeSafe request rejection does not trigger five-minute backoff. `ErrRejected` becomes a saved no-match result. Backoff occurs only when `SuggestOnce` returns an error. Source: `api/internal/worker/suggest.go:74-84,139-155` (`suggest`, `runSuggestions`).
- [x] **Medium, missing evidence/reconciliation policy:** The contract omits the 90-day initial backfill, one-second subsequent overlap, and success-only sync timestamp advancement. It also omits branch-only commit attribution, first-match selection, and the rule that PR linking never changes issue status. Sources: `api/internal/worker/reconcile.go:13-15,60-65,94-98` (`reconcileRepo`), `api/internal/worker/push.go:50-69` (`handlePush`), `api/internal/worker/pull_request.go:41-46,75-93` (`syncPullRequest`).

## web/README.md

- [x] **Low:** Global side effects omit clipboard writes, browser-history changes, and document-title updates. Sources: `web/src/ui/MermaidDiagram.tsx:copy:37–44`, `web/src/features/sprints/SprintBoard.tsx:writeView:29–33`, `web/src/routes/root.tsx:RootLayout:62–64`.

## web/public/README.md

No drift detected.

## web/src/README.md

No drift detected.

## web/src/app/README.md

- [x] **Medium:** Contract omits the shell's access boundary and live-stream side effect. `Shell` reads session state, starts workspace SSE, suppresses children while loading, shows sign-in when signed out, and rejects inaccessible workspaces. Its public props also include optional `slug` and injectable `navigate`. Source: `web/src/app/Shell.tsx:Shell:382–419`.

## web/src/features/README.md

No drift detected.

## web/src/features/activity/README.md

- [x] **Medium:** `useActivity` is documented as a generic query without its pagination contract. It returns an infinite query, starts with a null cursor, forwards `cursor`, and derives continuation from `next_cursor`. `ActivityFilters` supports `actor_id`, `verb`, `target_type`, and `target_id`, which the contract does not enumerate. Source: `web/src/features/activity/useActivity.ts:ActivityFilters:6–11`, `queryString:18–26`, `useActivity:30–38`.

## web/src/features/admin/README.md

- [x] **Medium:** Missing authorization and destructive-action invariants. `AdminLayout` disables admin queries for non-admins and never invokes page children without admin membership. `DangerPanel` requires exact slug confirmation before deletion. Sources: `web/src/features/admin/AdminLayout.tsx:AdminLayout:46–53,73`, `web/src/features/admin/DangerPanel.tsx:DangerPanel:30–40`.
- [x] **Medium:** Side effects are broader than the listed invalidations. Organisation and membership changes refresh private caches globally, self-removal and workspace deletion clear private caches before navigating, and GitHub connection polling runs every two seconds during specified transitional states. Sources: `web/src/features/admin/OrganisationPanel.tsx:OrganisationPanel:15–21`, `web/src/features/admin/MembersPanel.tsx:MembersPanel:30–45`, `web/src/features/admin/DangerPanel.tsx:DangerPanel:15–17`, `web/src/features/admin/GitHubPanel.tsx:GitHubPanel:37–41`.

## web/src/features/auth/README.md

- [x] **Medium:** “Pages take an injectable `navigate` prop” is false as a blanket interface guarantee. `ApproveCLI`, `CheckEmail`, `Expired`, and the recovery pages expose no such prop. Sources: `web/src/features/auth/ApproveCLI.tsx:ApproveCLI:30`, `web/src/features/auth/CheckEmail.tsx:CheckEmail:5`, `web/src/features/auth/Expired.tsx:Expired:5`, `web/src/features/auth/PublicRecovery.tsx:PublicSessionPending:7,PublicSessionError:18,PublicRecovery:34`.
- [x] **Medium:** CLI approval coverage omits four materially different consent modes: `login`, `manage`, `desktop`, and legacy `init`. The first three approve without workspace/project scope. Legacy init fetches projects and submits workspace/project selection. Denial and deadline-driven expiration are also undocumented. Source: `web/src/features/auth/ApproveCLI.tsx:PendingSignIn:14–20,ApproveCLI:46–81`.
- [x] **Medium:** Missing session-isolation invariants. Session reads use a 60-second stale time, disable retries, convert only HTTP 401 to signed-out state, and cancel/remove private queries plus clear mutation state when identity changes. Source: `web/src/features/auth/useSession.ts:sessionQueryOptions:21–42`.

## web/src/features/comments/README.md

- [x] **Medium:** Persistence is not uniformly owned through `onReply`, as claimed. `CommentComposer` requires `onSubmit(body)`, while `ReplyEditor` requires `onReply(commentId, body)` and `CommentThread` accepts that callback optionally. Sources: `web/src/features/comments/CommentComposer.tsx:CommentComposer:6–11,submit:36–49`, `web/src/features/comments/CommentThread.tsx:ReplyEditor:34–36,CommentThread:88–91`.

## web/src/features/dashboard/README.md

No drift detected.

## web/src/features/evidence/README.md

- [x] **Medium:** `EvidenceCard`'s public callback contract is missing. It requires `pr` and `issueStatus`, accepts optional `onMarkDone`, and offers that explicit status action only for merged PRs on unresolved issues. This distinction matters alongside the “never changes issue status” linking invariant. Source: `web/src/features/evidence/EvidenceCard.tsx:EvidenceCard:10–20,45–50`.
- [x] **Medium:** Suggestion mutation failure semantics are undocumented. HTTP 409 means another caller already handled the suggestion, so the component refreshes caller-supplied query keys and activity rather than displaying an error. Other errors remain visible. Source: `web/src/features/evidence/SuggestionLine.tsx:SuggestionLine:26–50`.

## web/src/features/feed/README.md

No drift detected.

## web/src/features/images/README.md

- [x] **Medium:** Missing security and cache contract. `protectedImageUrl` validates an existing URL rather than constructing or normalizing one: invalid slug/ID characters or any non-exact endpoint return `null`. Images use `['images', slug, target, targetId]`; deletion updates that cache immediately. Only admins or member uploaders receive deletion controls. Sources: `web/src/features/images/protectedImageUrl.ts:protectedImageUrl:3–6`, `web/src/features/images/ImagesSection.tsx:ImagesSection:97–107,120`.

## web/src/features/issues/README.md

- [x] **Medium:** “Invalidates `['issues', slug]` and `['activity', slug]` after writes” is not true for every write. List-page issue creation invalidates only issues. Label creation invalidates only labels. Sources: `web/src/features/issues/IssuesPage.tsx:IssuesPage:138–140`, `web/src/features/issues/IssuePage.tsx:IssuePage/createLabel:241–247`.
- [x] **Medium:** Missing list pagination/filter invariants. Requests use 50-row cursor pages and server counts. Filter changes reset cursor history. Only `status=open` initializes status from the URL, expanding to every status except done/cancelled. `project=unfiled` becomes `unfiled=true`. Source: `web/src/features/issues/IssuesPage.tsx:IssuesPage:98–127`.

## web/src/features/landing/README.md

- [x] **Medium:** “Side Effects: None” contradicts `PublicPageLayout`, which changes `document.title` and restores the previous title on cleanup. Source: `web/src/features/landing/PublicPageLayout.tsx:PublicPageLayout:38–42`.

## web/src/features/mentions/README.md

No drift detected.

## web/src/features/milestones/README.md

- [x] **Low:** Side effects omit updating the browser title to the loaded milestone name. Source: `web/src/features/milestones/MilestonePage.tsx:MilestonePage:94–96`.

## web/src/features/onboarding/README.md

- [x] **Medium:** Missing exported-component behavior and browser effects. `LinkedRepositories` reads account API tokens and polls every three seconds until a project-bound key for the workspace has been used, then invalidates onboarding state. `CopyField` writes to the clipboard with a manual-copy failure path. Sources: `web/src/features/onboarding/AgentSetup.tsx:LinkedRepositories:98–110`, `CopyField:151–169,188`.

## web/src/features/orgs/README.md

- [x] **Medium:** Cache clearing is documented only for leaving. Successful organisation creation and invitation acceptance also call `clearPrivateQueries` before entering the workspace. Expired invitation acceptance navigates to `/expired`, another undocumented destination. Source: `web/src/features/orgs/NewOrganisation.tsx:NewOrganisation/enter:29–40`.

## web/src/features/palette/README.md

- [x] **Medium:** Side effects omit network reads and their limits. Quick creation fetches milestones. Nonempty, non-issue-key searches wait 150 ms, then fetch every workspace issue page through `listAllWorkspaceIssues`. These reads bypass TanStack Query, and failures clear results instead of displaying a query error. Source: `web/src/features/palette/CommandPalette.tsx:NewIssueForm:92–109,CommandPalette:260–288`.

## web/src/features/profile/README.md

- [x] **Medium:** Missing secret-lifetime invariant. Created API tokens are held in component state for one-time display, and keyed section content remounts when the page changes. Workspace changes remount the profile too. Token copying writes to the clipboard, including a legacy DOM-copy fallback. Source: `web/src/features/profile/Profile.tsx:ProfileRoute:19–23,Profile:47,ApiTokens:101–116,copyToken:142–162`.
- [x] **Medium:** Missing private-cache effects around GitHub identity changes. Linking clears private caches before full-page navigation. Removing an account refreshes private queries globally. Token revocation also invalidates onboarding state, not only the token query. Sources: `web/src/features/profile/GitHubAccountsTable.tsx:AccountRow:72–79,108–115`, `web/src/features/profile/Profile.tsx:ApiTokens/revoke:119–125`.

## web/src/features/projects/README.md

No drift detected.

## web/src/features/recap/README.md

No drift detected.

## web/src/features/reports/README.md

- [x] **Medium:** The listed query-key shape omits the stale report's fourth element. Actual key is `['reports', slug, 'stale', STALE_DAYS]`, where `STALE_DAYS` is `14`. The other report keys have three elements. Source: `web/src/features/reports/Reports.tsx:STALE_DAYS:161,Reports:163–180`.

## web/src/features/sprints/README.md

- [x] **Medium:** Missing board state and mutation invariants. `?view=board` persists through `history.replaceState`; widths below 640px use the list. Status moves cancel both issue queries, snapshot and optimistically update their caches, restore snapshots on error, and expose Undo feedback. Sources: `web/src/features/sprints/SprintBoard.tsx:readView:25–26,writeView:29–33,useWideEnoughForBoard:38–49,SprintBoard/moveIssue:502–538`, `web/src/features/sprints/SprintKanban.tsx:MoveToast:273–301`.
- [x] **Medium:** `issuesForSprint` is named without documenting its selection algorithm. Only active sprints merge milestone-free issues, optionally restricted to the sprint's project, deduplicated by issue ID. The supporting workspace query walks all issue pages, unlike the sprint-specific request capped at 200. Sources: `web/src/features/sprints/sprintIssues.ts:issuesForSprint:8–22`, `web/src/features/sprints/SprintBoard.tsx:SprintBoard:466–476`.

## web/src/features/work/README.md

- [x] **Medium:** Missing core public-helper invariants. `projectChoices` preserves the currently assigned archived project. `milestoneChoices` excludes completed-sprint milestones except the current selection. `reconcileLinks` moves project selection with a milestone and clears an incompatible milestone when project changes. The shared member cache must retain its response envelope. Source: `web/src/features/work/workLinks.ts:projectChoices:31–39,milestoneChoices:47–78,reconcileLinks:98–112,membersQuery:116–122`.

## web/src/lib/README.md

No drift detected.

## web/src/routes/README.md

- [x] **Medium:** Missing route-level behavior. Bare administration redirects to General; bare profile redirects to General or Agent config for the legacy fragment while preserving query strings. Unknown admin/profile sections throw not-found. `RootLayout` selects shell versus public layout and updates product titles. Sources: `web/src/routes/router.tsx:adminRoute:166–171,adminPageRoute:174–179,profilePageRoute:197–201,routes:273–279`, `web/src/routes/root.tsx:RootLayout:56–75`.

## web/src/ui/README.md

- [x] **Medium:** Missing trust-boundary invariants for exported rendering APIs. Markdown sanitizes parsed HTML and removes user-supplied Mermaid placeholder attributes. Diagram rendering rejects oversized sources, configuration blocks, and external-image syntax, caps edges at 500, sanitizes SVG, and emits a network-blocked CSP document for sandboxed frames. Sources: `web/src/ui/Markdown.tsx:renderMarkdown:8–38`, `web/src/ui/mermaid.ts:renderDiagram:7–24,41–47,diagramDocument:58–59`, `web/src/ui/MermaidDiagram.tsx:MermaidDiagram:64,70`.
- [x] **Medium:** “None beyond DOM rendering” omits clipboard writes and system-color-scheme subscriptions. The shared `List` also has an undocumented public keyboard contract: `j`/ArrowDown, `k`/ArrowUp, Enter activation, and `aria-activedescendant` selection. Sources: `web/src/ui/MermaidDiagram.tsx:MermaidDiagram:17–22,copy:37–44`, `web/src/ui/List.tsx:List:20–47`.
