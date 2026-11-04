# store

## Overview
Postgres data access for every domain entity. Methods hang off `*Store` (157 exported methods across 31 files).

## Interface
- `type Store`, `func New(pool *pgxpool.Pool) *Store`
- Domains: users, sessions, login tokens and confirmations, CLI sessions, API tokens, workspaces, organisations, memberships and GitHub identities, invites, onboarding, projects, sprints and snapshots, milestones, issues, labels, comments and mentions, activity, images, worklogs, reports, suggestions, evidence, GitHub installations, setup state, events, pull requests, and the `job` queue.
- Queue: `ClaimJob`, `CompleteJob`, `FailJob`, `DeliveryPayload`, `MarkDeliveryProcessed`, `ActiveRepo`
- `const SessionTTL = 30 * 24 * time.Hour`
- Errors: `ErrStaleJob`, `ErrImageQuota`, `ErrImageCount`, `ErrInvalidSprint`, `ErrSuggestionClosed`

### Exported method and package-helper inventory
Names below are `(*Store)` methods unless marked **helper**. Each source link contains the signature, input/result structs, and implementation. Transaction helpers use the caller's transaction rather than opening a separate one.
The inventory covers all 157 exported Store methods and 31 package-level functions. [TokenScope.Scoped](api_token.go) is the additional value-type method: it reports whether `ProjectID` is non-nil.

#### Core and activity
- [New](store.go): **helper**, wrap a Postgres pool in a Store.
- [Pool](store.go): expose the underlying pool.
- [InTx](store.go): run a callback and commit on success, with deferred rollback on error or panic.
- [RecordActivity](activity.go): **helper**, insert activity in the transaction containing its domain change; zero actor stores NULL.
- [NextIssueKey](activity.go): allocate the next workspace issue number and formatted key under the workspace row lock.
- [ListActivity](activity.go): filter and page activity by descending ID, returning a continuation cursor.
- [LatestActivityID](activity.go): read the workspace's activity watermark, or zero.
- [Dashboard](activity.go): assemble personal workspace dashboard data.

#### Users, membership, workspace and onboarding
- [ListWorkspaceMemberships](user.go): list administrative membership records with user projections.
- [ListWorkspaceMembers](user.go): list current users for people/assignee selectors, excluding pending invitations.
- [UpdateWorkspaceMembershipRole](user.go): change a role with an admin recheck and last-admin protection.
- [UpsertUserByEmail](user.go): find or create a trimmed, lowercase email identity.
- [MembershipsForUser](user.go): list a user's workspace memberships.
- [MembershipForSlug](user.go): resolve one user's membership by workspace slug.
- [HashToken](user.go): **helper**, return the token's SHA-256 hex digest.
- [CreateSession](user.go): return a random session secret and persist its hash with the supplied TTL.
- [UserBySessionToken](user.go): resolve a non-expired session secret to its user.
- [DeleteSession](user.go): delete the session identified by a raw secret's hash.
- [CreateWorkspace](workspace.go): create a workspace and its actor's admin membership atomically.
- [UpdateWorkspaceName](workspace.go): rename after an admin lock/recheck and record actual changes.
- [LockWorkspaceWriterTx](workspace.go): **helper**, lock workspace first and require the actor's current admin/member role.
- [LockWorkspaceAdminTx](workspace.go): **helper**, lock workspace first and require the actor's current admin role.
- [DeleteWorkspace](workspace.go): delete after the admin guard, allowing schema cascades.
- [LeaveWorkspace](workspace.go): remove the actor's membership without losing the last admin.
- [RemoveWorkspaceMembership](workspace.go): admin removal of a membership with last-admin protection and activity.
- [DefaultOrganisationName](onboarding.go): **helper**, derive a nonempty display name from user name or email.
- [SlugFrom](onboarding.go): **helper**, derive an organisation slug, decomposing accents.
- [PrefixFrom](onboarding.go): **helper**, derive an issue prefix from name initials/letters.
- [SuggestOrganisation](onboarding.go): propose organisation defaults with an available slug.
- [CreateWorkspaceWithFreeSlug](onboarding.go): retry workspace creation with numbered slugs on duplicate conflicts.
- [Onboarding](onboarding.go): read whether the user has an organisation, any API token, and a token used at least once.
- [LinkMembershipGitHubIdentity](membership_identity.go): set an organisation-specific GitHub account and reattribute mirrored PRs/reviews.
- [UnlinkMembershipGitHubIdentity](membership_identity.go): remove that account without deleting attributed evidence.
- [GitHubIdentityForMembership](membership_identity.go): report the effective organisation-specific or available global identity.

#### Sessions, email confirmation and invitations
- [RememberWorkspace](session.go): store a session's preferred workspace only when its user belongs there.
- [LastWorkspace](session.go): resolve accessible remembered membership, falling back to the earliest workspace.
- [DeleteExpiredSessions](session.go): delete all expired sessions and return the affected count.
- [CleanupExpiredAuthentication](session.go): bounded cleanup of expired login and GitHub authorization/setup state, retaining invitations.
- [NormalizeEmail](login_token.go): **helper**, trim/lowercase one mailbox, rejecting display names and address lists.
- [NormalizeIP](login_token.go): **helper**, canonicalize an IP and unmap IPv4-mapped IPv6 addresses.
- [ValidLoginReturnTo](login_token.go): **helper**, accept only empty continuation or `/cli/approve?code=XXXX-XXXX` using the user-code alphabet.
- [IssueLoginToken](login_token.go): issue a single-use email token with no continuation, storing only its hash.
- [IssueLoginTokenWithReturnTo](login_token.go): issue with a validated CLI continuation and email/IP issuance limits; invitation and continuation cannot be combined.
- [ConfirmLogin](login_confirmation.go): consume a login token and establish user/session, including invitation acceptance when bound.
- [ListMyInvites](invite.go): list live invitations matching the user's email.
- [ListWorkspaceInvites](invite.go): list a workspace's live invitations.
- [PreviewInviteToken](invite.go): resolve a live invitation by raw secret.
- [LockInviteWorkspaceTx](invite.go): **helper**, acquire the invite workspace lock before login-token/user locks.
- [CreateInvite](invite.go): create an invitation and return its raw secret.
- [ReplaceInvite](invite.go): preserve/invalidate the old invitation and return a new invitation and secret.
- [RevokeInvite](invite.go): revoke an invitation after the admin guard.
- [AcceptMyInvite](invite.go): accept by invitation ID for the current user.
- [AcceptInviteToken](invite.go): resolve the raw invitation secret then accept for the user.
- [AcceptInviteTx](invite.go): **helper**, consume a live email-matching invitation and create membership atomically, preserving an existing member's role.

#### API tokens and device consent
- [CreateAPIToken](api_token.go): create a personal credential and return its raw value once.
- [ListAPITokens](api_token.go): return token metadata, never token hashes.
- [DeleteAPIToken](api_token.go): delete only a credential owned by the specified user.
- [LookupAPIToken](api_token.go): authenticate a secret, return user/token ID/scope, and update usage at most once per minute.
- [RevokeAPITokenByID](api_token.go): revoke the credential identified by the authenticated request.
- [NormalizeUserCode](cli_session.go): **helper**, uppercase and retain only characters in the device user-code alphabet.
- [FormatUserCode](cli_session.go): **helper**, display an eight-character code as two groups of four.
- [CreateCLISession](cli_session.go): start a legacy `init` device session.
- [CreateCLISessionForFlow](cli_session.go): start `init|login|manage|desktop` consent and return device secret plus browser-visible session.
- [CLISessionByCode](cli_session.go): read only pending, unexpired consent by user code.
- [ApproveCLISession](cli_session.go): approve legacy init for one workspace/project after checking writer membership.
- [DenyCLISession](cli_session.go): deny pending, unexpired consent.
- [ApproveCLIUnscoped](cli_session.go): record explicit `login|manage|desktop` consent without workspace/project selection.
- [IssueProjectToken](cli_session.go): create or rotate a setup credential's project child after checking current access and active project.
- [CollectCLISession](cli_session.go): poll by device secret and mint/collect the approved grant once, in one transaction.

#### Projects, sprints, milestones and issues
- [ValidProjectKey](project.go): **helper**, check `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`.
- [ValidProjectStatus](project.go): **helper**, accept `active|archived`.
- [NormalizeProjectKey](project.go): **helper**, trim and lowercase a key.
- [CreateProject](project.go): create a workspace project under the writer guard.
- [ListProjects](project.go): list projects, optionally archived, with issue-status counts.
- [GetProjectByKey](project.go): read a workspace project by key.
- [ProjectIDByKey](project.go): resolve only its identifier.
- [UpdateProject](project.go): apply a patch and record activity per actual change.
- [SetRepoProject](project.go): assign or clear a repository's project mapping.
- [ScopeNames](project.go): resolve scoped workspace/project IDs to slug/key.
- [UpdateSprint](sprint.go): patch name/dates, rejecting blank names and invalid or reversed dates.
- [CreateSprint](sprint.go): insert a project sprint after writer and workspace-project checks.
- [ListSprints](sprint.go): list workspace sprints, optionally filtered to one project.
- [GetSprint](sprint.go): read one workspace sprint.
- [ActivateSprint](sprint.go): activate a sprint, first closing the previous active sprint in the same project.
- [CloseSprint](sprint.go): complete, snapshot, roll unfinished work forward, and record activity atomically.
- [GetSnapshot](snapshot.go): read a frozen workspace sprint report.
- [ValidMilestoneStatus](milestone.go): **helper**, accept `planned|in_progress|completed|cancelled`.
- [CreateMilestone](milestone.go): create a milestone under the writer guard.
- [ListMilestonesForSprint](milestone.go): list a sprint's milestones with issue counts and latest comments.
- [ListMilestones](milestone.go): list workspace-wide filing choices.
- [GetMilestone](milestone.go): read one workspace milestone.
- [UpdateMilestone](milestone.go): patch a milestone under the writer guard.
- [MilestoneProjectID](milestone.go): resolve its project through the owning sprint.
- [ListProjectMilestones](milestone.go): list filing choices restricted to a project's sprints.
- [ValidIssueStatus](issue.go): **helper**, accept `backlog|todo|in_progress|in_review|done|cancelled`.
- [CreateIssue](issue.go): create an issue under the writer guard.
- [ListIssues](issue.go): filter/page issues using `(position, id)` and return a continuation cursor.
- [CountIssues](issue.go): return full filtered/total counts and assignee choices, ignoring the cursor and respecting project scope.
- [GetIssueByKey](issue.go): read an issue with labels and direct children.
- [UpdateIssue](issue.go): apply an issue patch under the writer guard.
- [IssueProjectID](issue.go): return the issue's project, or nil for unfiled work.
- [CreateLabel](label.go): create a workspace label under the writer guard.
- [ListLabels](label.go): list labels by name.
- [DeleteLabel](label.go): delete a workspace label under the writer guard.
- [SetIssueLabels](label.go): replace an issue's entire label set atomically.

#### Comments, mentions, images and worklogs
- [ValidCommentTarget](comment.go): **helper**, accept `issue|milestone|project`.
- [ValidCommentKind](comment.go): **helper**, accept `progress|decision|blocker|note`; ordinary discussion uses an absent kind, not an accepted empty string.
- [CreateComment](comment.go): create comment, activity and mentions in one transaction.
- [PromoteCommentToIssue](comment.go): create a ticket from a project log entry, retaining and linking the original entry.
- [ListComments](comment.go): return live comments oldest-first with nested replies.
- [UpdateComment](comment.go): edit only as the author, even for admins.
- [DeleteComment](comment.go): soft-delete as author or admin.
- [ParseMentions](mention.go): **helper**, parse distinct mention names outside matched code spans.
- [CommentProjectID](mention.go): resolve a live comment target's project, nil for an unfiled issue.
- [ListMentions](mention.go): list the user's mentions newest-first, optionally unread/project-filtered, excluding deleted comments.
- [UnreadMentionCount](mention.go): count live unread mentions for the workspace/user.
- [MarkMentionsRead](mention.go): mark selected comments, or all with an empty list, within optional project scope.
- [ListImages](image.go): list image metadata for a workspace target.
- [CreateImage](image.go): insert a sanitized image under workspace quota serialization.
- [ImageContent](image.go): return filename/content type and stored bytes for a workspace image.
- [DeleteImage](image.go): delete under writer, uploader/admin and workspace quota locks.
- [ImageProjectID](image.go): resolve the target's project, returning not-found for unfiled issue images.
- [Worklog](worklog.go): combine the user's notes, touched issues, authored PRs and commits across current memberships, with window/project/workspace filters.
- [WindowForDays](worklog.go): **helper**, return a UTC date range including today; nonpositive days use the seven-day default.
- [ParseRemote](resolve.go): **helper**, parse owner/repository from supported Git remote forms without guessing on invalid input.
- [ResolveRepo](resolve.go): resolve a remote only among the user's organisations, reporting ambiguity instead of choosing one.

#### GitHub setup, installation state, evidence and queue
- [CreateGitHubLinkAuthorization](github_setup.go): start session-bound profile or workspace-specific OAuth linking with state/PKCE.
- [CreateGitHubSetup](github_setup.go): start an admin-authorized installation setup bound to the browser session.
- [StartGitHubInstallationAuthorization](github_setup.go): bind a positive candidate installation to setup and return OAuth state/challenge.
- [GetGitHubAuthorization](github_setup.go): resolve authorization state for its session/user.
- [ClaimGitHubAuthorization](github_setup.go): lock and claim authorization for the expected purpose.
- [CompleteGitHubLink](github_setup.go): complete validated identity linking after rechecking session/state.
- [LockGitHubInstallationAuthorizationTx](github_setup.go): **helper**, lock/revalidate admin, session and installation authorization before binding.
- [CompleteGitHubInstallationAuthorizationTx](github_setup.go): **helper**, revalidate then mark setup/authorization completed and erase the verifier.
- [CompletedGitHubSetup](github_setup.go): return a completed setup's workspace slug only for matching live session/user/candidate.
- [UnlinkGitHub](github_setup.go): unlink the global identity after session and identity-mutation guards.
- [BindInstallation](installation.go): bind verified provider evidence after rechecking the authorization claim under locks.
- [GitHubStatus](installation.go): derive the workspace installation's connection/sync status.
- [RequestInstallationSync](installation.go): admin-requested repository synchronization.
- [RequestInstallationSyncForEvent](installation.go): schedule only a verified, bound, live, unsuspended installation.
- [ScheduleInstallationSyncs](installation.go): schedule eligible installations due for repository refresh.
- [InstallationSyncCurrent](installation.go): check binding/generation and active installation state for a repository-sync job.
- [ApplyInstallationRepos](installation.go): atomically apply a complete listing, rejecting stale generations and foreign repository ownership.
- [FailInstallationSync](installation.go): save a safe sync error for the matching binding/generation.
- [InstallationEvent](installation.go): serialize lifecycle updates and return state-reconciliation work when needed.
- [ApplyInstallationState](installation.go): apply authoritative suspension state only to the captured generation/binding.
- [InstallationStateCurrent](installation.go): check whether a lifecycle-state job remains current.
- [ActiveRepo](installation.go): resolve a repository only through its active verified installation binding.
- [WithActiveRepo](installation.go): guard evidence writes against disconnect/rebind and generation changes within a transaction.
- [UpsertPullRequest](pull_request.go): mirror a PR while rejecting older provider state.
- [UpsertPullRequestTx](pull_request.go): **helper**, mirror a PR in the caller's transaction with the same ordering guard.
- [LinkPRTx](pull_request.go): **helper**, attach PR evidence, report whether newly linked and record activity only for new links; never set issue status.
- [ManualLink](pull_request.go): attach a PR after verifying workspace ownership and writer access.
- [Unlink](pull_request.go): remove a PR/issue link while preserving the mirrored PR.
- [IssueIDByKey](pull_request.go): resolve a workspace issue key to its identifier.
- [UnlinkedPullRequests](pull_request.go): list PRs with no issue link.
- [EvidenceForIssue](pull_request.go): collect linked PRs, reviews and commits.
- [RepoByGitHubID](pull_request.go): resolve a stored repository by provider ID.
- [ListRepos](pull_request.go): list workspace repositories ordered by owner/name.
- [LinkRepo](pull_request.go): bind a repository, creating its installation row if needed.
- [ReposDueForSync](pull_request.go): list eligible never-synced or stale repositories.
- [WorkspaceIssuePrefix](pull_request.go): read the prefix used for issue-key matching.
- [PullRequestIDByNumber](pull_request.go): resolve a stored PR number within one repository.
- [UpsertReviewTx](pull_request.go): **helper**, mirror reviews by provider review ID.
- [UpsertCommitTx](pull_request.go): **helper**, insert commit evidence idempotently by repository/SHA.
- [MarkDeliveryProcessed](pull_request.go): timestamp a processed webhook delivery.
- [DeliveryPayload](pull_request.go): load its event type and raw payload.
- [ResolveEvidence](evidence.go): resolve an existing PR/commit reference without creating unsynced evidence.
- [AttachEvidenceToIssue](evidence.go): attach stored PR/commit evidence without changing issue status.
- [RecordDelivery](github_event.go): deduplicate delivery ID, persist payload and enqueue processing atomically; return whether new.
- [EnqueueJob](job.go): insert JSON job payload in the caller's transaction.
- [ClaimJob](job.go): claim the oldest ready job with a five-minute lease and attempt generation.
- [CompleteJob](job.go): delete a completed job only if its generation is current.
- [FailJob](job.go): save failure reason and schedule backoff or dead-letter, fenced by generation.

#### Suggestions and reports
- [StaleSuggestionSubjects](suggestion.go): select up to the limit per subject kind needing a new answer.
- [SuggestionCandidates](suggestion.go): rank open issues by project, author assignment and recent activity.
- [SaveSuggestion](suggestion.go): save an answer while preserving dismissal of the same issue and leaving accepted work alone.
- [PullRequestSuggestions](suggestion.go): fetch suggestions keyed by PR ID.
- [SuggestedNotes](suggestion.go): list note suggestions in a workspace.
- [AcceptSuggestion](suggestion.go): accept a pending suggestion and return its issue key.
- [DismissSuggestion](suggestion.go): dismiss a pending suggestion.
- [SuggestionEvalCases](suggestion.go): read cases for offline suggestion evaluation.
- [JevSuggestionsEnabled](suggestion.go): read the workspace suggestion setting.
- [SetJevSuggestions](suggestion.go): change the setting after the admin guard.
- [PersonActivity](report.go): count actor activity with optional date/project filters.
- [MilestoneCompletion](report.go): report sprint milestone completion, excluding cancellations and preferring frozen snapshots.
- [IssuesClosedPerSprint](report.go): count done and total sprint issues, preferring frozen snapshots.
- [StaleIssues](report.go): find unfinished issues whose newest row/comment/activity/linked-PR signal exceeds the age threshold.

## Invariants
- `ClaimJob` uses `FOR UPDATE SKIP LOCKED` and pushes `run_after` 5 minutes out as a lease. Delivery is at least once.
- `attempts` is the claim generation. `CompleteJob` and `FailJob` fence on it, so stale workers get `ErrStaleJob`.
- Advisory transaction locks serialize API token creation per user, login email issuance, membership identity changes and installation binding.
- [Image limits](image.go): 100 per issue or milestone, 1000 per organisation, and `ImageQuotaBytes = 512 << 20` (512 MiB) per organisation.
- [API-token issuance](api_token.go) caps each user at 20 tokens across kinds.
- [Sprint creation](sprint.go) inserts the supplied name unchanged, including empty text. The schema requires non-NULL name and ordered dates. Only `UpdateSprint` rejects a blank name and validates date syntax in Go.
- [Sprint transitions](sprint.go) use one transaction: activation closes the previous active sprint in the same project; closure captures its snapshot before carrying incomplete issues forward and records activity before commit. Other projects' active sprints remain unchanged.
- [Roll-forward](snapshot.go) changes filing, not issue status. Activation supplies the destination sprint; manual close chooses the same project's earliest upcoming sprint and leaves issues in place if none exists. Milestones match by name or are created in the destination.
- [FailJob](job.go) dead-letters at attempt 5. Retry delay is `2^attempts` seconds, capped at one hour.

## Side Effects
- All reads and writes go to Postgres.
- [DeleteExpiredSessions](session.go) deletes every expired session in one statement, without batching. `CleanupExpiredAuthentication` instead bounds login-token and GitHub authorization/setup candidate cleanup to 1000 rows per category.

## Verification
- Run: `cd api && go test ./internal/store/...`
