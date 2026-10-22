---
name: management
description: Manage Velvet organisation members, invitations, projects, GitHub settings, organisation reports, and mentions with separately consented CLI administration. Use only when the user requests these account-wide operations.
---

# Velvet administration

Project work and account administration are separate trust boundaries.
`velvet admin login` opens separate browser consent for a personal management credential.
That credential permits account-wide administration subject to the user's current roles, not only the linked project.
Never treat setup consent as management consent.
Never reuse setup credentials, project credentials, repository YAML, or `VELVET_TOKEN` for management.
Do not start management login merely to bypass a project-scope error.
The user must explicitly approve the wider access in the browser.

```bash
velvet admin login --server https://velvet.example.com --account USER_ID
velvet admin whoami --server https://velvet.example.com --account USER_ID
velvet admin logout --server https://velvet.example.com --account USER_ID --yes
```

Login accepts `--no-browser` to print the consent URL and reuses a valid saved management credential.
For these account commands only, server selection is `--server`, then `VELVET_SERVER`, then the hosted default.
An omitted account selects the last management login for that server, never the repository's account.
Prefer explicit server and account even here.
Management logout requires approval and `--yes`, revokes only management access, and leaves setup and project keys unchanged.
Ordinary setup logout does not revoke separately consented management access.

## Choose scope explicitly

Every organisation operation requires `--server URL --account USER_ID --organisation SLUG`.
Do not infer those values from the current repository or silently switch accounts.
Read first, verify the intended target, then apply only the requested change.
Flags may precede or follow positional arguments.

```bash
velvet admin members list --server https://velvet.example.com --account USER_ID --organisation lab
velvet admin projects show web --server https://velvet.example.com --account USER_ID --organisation lab
```

## Supported operations

Use `velvet admin --help` for the exact arguments.
All commands below still need the three explicit scope flags:

- `members list`, `members set-role MEMBERSHIP_ID ROLE --yes`, `members remove MEMBERSHIP_ID --yes`.
- `invites list`, `invites create EMAIL ROLE`, `invites resend INVITE_ID`, `invites revoke INVITE_ID --yes`.
- `organisation show`, `organisation update --name NAME`, `organisation delete --yes`, `organisation leave --yes`.
- `projects list [--include-archived]`, `projects show KEY`, `projects create KEY --name NAME [--description TEXT]`.
- `projects update KEY [--name NAME] [--description TEXT] [--status active|archived]`, `projects archive KEY --yes`.
- `github status`, `github repositories`, `github sync`, `github connect`, `github identity`, `github link`, `github unlink --yes`.
- `github map-repository REPO_ID --project-id PROJECT_ID`, `github unmap-repository REPO_ID --yes`.
- `reports activity [--from YYYY-MM-DD] [--to YYYY-MM-DD]`, `reports milestones`, `reports closed`, `reports stale [--days N]`.
- `mentions list [--unread]`, `mentions read COMMENT_ID...`, `mentions read --all --yes`.

Roles are `admin`, `member`, and `viewer`. A credential never overrides server role checks.
Reports and mentions here cover the selected organisation, not only the repository project.
GitHub connect and link print trusted browser start URLs. The user completes OAuth or installation in the browser.
Never fabricate an OAuth result, connection, or installation.

## Confirmation and limits

Ask for explicit approval before deletion, leaving an organisation, removing members, changing roles, archiving projects, revoking invitations, or unlinking integrations.
Then pass the required `--yes`. Setting project status to `archived` also requires `--yes`.
Do not use `--yes` as standing consent for future actions.
Mention reads change notification state. Mark only requested items, and require approval before `read --all --yes`.
Never change ticket, sprint, or milestone status because an admin action, code change, evidence link, or deployment occurred.
