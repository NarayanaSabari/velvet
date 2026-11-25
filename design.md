# Velvet design standards

Status: source-grounded standard for future Velvet interface work.

This document is the single source of truth for the personal-first product direction and the existing restrained monochrome workspace UI.

It separates current behavior from desired standards so that documentation does not imply that an unimplemented UI change has landed.

It does not claim that the Issues page or any other UI is fixed.

## Scope and product stance

Velvet is personal-first: the ticket and its private journal are first-class, GitHub is optional read-only evidence, and ownership is per Velvet user.

Personal work must not require membership or administrator access to an employer organisation.

Existing organisation tickets remain organisation-scoped and continue to use the current membership and role model.

A GitHub state, branch, pull request, or evidence link never changes a Velvet issue status automatically.

The interface should feel calm, fast, private, keyboard-first, and useful at the moment a person records work.

### Current baseline

The current SPA route tree is workspace-oriented under `/w/$slug` and exposes dashboard, feed, sprint, milestone, issue, project, evidence, report, mention, administration, and profile routes.

`web/src/features/projects/ProjectsPage.tsx` is the projects index: a project is the durable thing work belongs to, and its open count links into the Issues page filtered to exactly those issues.

`web/src/features/sprints/SprintList.tsx` lists sprints under one section per project, because each project runs its own sprints and two projects may use the same sprint name.
The New sprint form asks for the project first, and an organisation with no projects sees an empty state that sends it to Projects instead of a form that cannot succeed.
The sprint board's eyebrow names and links the sprint's project, and the Dashboard shows one section per project with an active sprint.

`/me/worklog` is the one route that deliberately sits outside `/w/$slug`, because it gathers work from every organisation the person belongs to and scoping it to one would answer a smaller question.
`web/src/features/recap/Recap.tsx` groups by day and then by organisation, and links the Markdown form for pasting into a message.

`web/src/app/Shell.tsx` currently gates workspace content through memberships and the `admin`, `member`, and `viewer` roles.
Its sidebar separates the cross-organisation work log from the workspace-scoped links, because that entry leaves the current organisation.

The personal-first product direction is documented in [the personal worklog specification](docs/superpowers/specs/2026-09-09-ticket-first-personal-worklog-design.md), but the current route tree does not expose a separate personal-project route.

The current implementation therefore provides a workspace UI baseline, not proof that the personal flow is implemented.

### Desired standard

New personal surfaces should preserve private ownership, optional GitHub evidence, explicit user-controlled status, and no account-wide or cross-user data assumptions.

New workspace surfaces should reuse the same visual language rather than creating a second product identity.

## Visual language and tokens

The palette is restrained monochrome, with color reserved for semantic state.

The source of truth for these values is [`web/src/index.css`](web/src/index.css).

| Token | Light value | Dark value | Use |
| --- | --- | --- | --- |
| `--color-ink` | `#000000` | `#ffffff` | Primary text, borders, and primary action fill. |
| `--color-paper` | `#ffffff` | `#0a0a0a` | Page and control surfaces. |
| `--color-grey-100` | `#f5f5f5` | `#171717` | Hover, selected, and quiet surface fill. |
| `--color-grey-200` | `#e5e5e5` | `#262626` | Dividers and low-emphasis borders. |
| `--color-grey-300` | `#d4d4d4` | `#404040` | Control borders and neutral state borders. |
| `--color-grey-500` | `#737373` | `#a3a3a3` | Metadata and supporting text. |
| `--color-grey-700` | `#404040` | `#d4d4d4` | Strong supporting text. |
| `--color-blocked` | `#b91c1c` | `#f87171` | Errors and destructive actions only. |
| `--color-stale` | `#b45309` | `#fbbf24` | Stale or attention-needed state only. |
| `--color-done` | `#15803d` | `#4ade80` | Completed state only. |

Do not add decorative hues, gradients, or a second neutral palette without an explicit design decision and source-token update.

Status must remain understandable from text, labels, icons, or structure without relying on color.

The existing font stack is `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`.

Body copy is 16px with a 1.5 line height through `--text-base` or `--text-sm`.

Metadata and compact labels are 14px with a 1.5 line height through `--text-xs`.

Primary page headings are 24px with a 1.25 line height through `--text-lg`.

The public landing page alone may use `--text-display`, a responsive 48px to 96px scale with a 0.95 line height and tight tracking.

Do not use the display token inside the authenticated product shell.

The token names are intentionally nontraditional because `--text-xs` is 14px and `--text-sm` is 16px in this project.

Use the existing type tokens instead of introducing 12px body copy or one-off heading sizes.

Controls use `--radius-control: 6px` and larger surfaces use `--radius-surface: 8px`.

The shared interaction curve is `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`.

The shared button press contract is a `160ms` transform transition and `scale(0.97)` on pointer activation, as implemented by `.ui-button`.

The shared focus contract is a `2px` ink outline with a `1px` offset from `:focus-visible`.

### Widths, breakpoints, and spacing

The installed Tailwind default breakpoints used by the web package are `sm` 640px, `md` 768px, `lg` 1024px, and `xl` 1280px.

The shell sidebar is `sm:w-52 xl:w-60`, which is 208px from the `sm` breakpoint and 240px at `xl` and above.

Workspace pages fill the main region with `w-full min-w-0` and have no page-level maximum width, so wide monitors are not left with an empty band beside the content.

Readable-measure caps apply only to prose and single inputs inside a page, never to the page itself.

The issue detail rail is `lg:grid-cols-[minmax(0,1fr)_17rem]`, which gives the metadata rail 272px and a 32px `gap-8` at 1024px and above.

The profile page fills the workspace width like its siblings.
Inside it, the API-token name field keeps a `max-w-2xl` (672px) measure, and the Agent config copy fields and setup tabs keep a `max-w-3xl` (768px) measure.

Markdown content uses `max-w-[46rem]`, which is 736px, so long descriptions keep a readable line length inside a full-width page.

The dashboard's secondary column is constrained between 20rem and 30rem, which is 320px to 480px, at `xl` and above.

The mobile main region uses 12px horizontal padding, 16px top padding, and 96px bottom padding to clear the fixed navigation.

The desktop main region uses 16px padding, while the desktop sidebar uses 12px padding.

Use the existing 4px spacing scale with 8px row insets, 12px control or card padding, 16px page padding, 24px section separation, and 32px multi-column separation where the source pattern calls for them.

Keep the mobile bottom safe-area inset used by `Shell.tsx` and do not introduce horizontal overflow to recover hidden content.

Workspace pages that share a shell must use the same left content edge and heading rhythm as their closest sibling pages rather than centering one page in isolation.

For wide-layout work, compare the changed page and its closest sibling side by side at 1720x1000 in both empty and populated states, checking the page edge, heading baseline, and control density before finalizing the layout.

## Page archetypes

### Shared shell

Use `Shell` and `NavLink` rather than recreating workspace navigation inside a page.

At 640px and above, the shell shows a sticky sidebar on the `grey-100` surface with the organisation identity and switcher, a Search control that opens the command palette, scrollable navigation, and the account menu pinned to the bottom.

Search is Astryx's `CommandPalette`, opened from the sidebar or with Cmd/Ctrl+K. Velvet supplies its results: commands ranked by how well they match, shown at once, then issues the server finds. Enter runs the top result unless an arrow key has highlighted another. New issue opens its own Astryx `Dialog` with the form.
The account menu in the sidebar and the More menu in the phone tab bar are Astryx `DropdownMenu`s that open above their trigger. Both end with Leave organisation, which asks first in an Astryx `AlertDialog`, and Sign out. On phones every menu row and the header's search button is a 44px touch target.
The sidebar navigation is grouped under visible section labels: Workspace for planning surfaces and Administration, Activity for the team feed, mentions, and unlinked pull requests, and Across organisations for the work log.

Each navigation link pairs a 16px icon from `web/src/ui/Icon.tsx` with its text label, and the icon never replaces the label.

The desktop sidebar is Astryx's Side Nav inside Velvet's own page frame: its sections, items, and selected state are Astryx's, and the current page is marked with `aria-current="page"` and a filled row at medium weight, so selection is never colour alone. The organisation switcher is an Astryx dropdown. The account menu and the phone tab bar are still Velvet's own.

Supporting text on the grey sidebar surface uses `grey-700`, because `grey-500` on `grey-100` falls below 4.5:1 in the light scheme.

Below 640px, the shell shows a workspace header with a 44px Search button and a fixed five-slot bottom navigation with icons, labels, and a safe-area inset.

The current mobile tabs expose Dashboard, Issues, Sprints, Mentions, and More, with the remaining links in the More menu.

Active navigation must expose `aria-current="page"` on exactly one link and a visible non-color-only selected treatment.

Milestone pages mark Sprints as current. When the current page sits inside the mobile More menu, the More button takes the selected treatment and an accessible description, not `aria-current`, because it is a button and not a link to the page.

A link whose target carries a query string is current only on exactly that path and query.

Page content must remain `min-w-0` inside the shell so long titles and controls cannot widen the document.

### List and index pages

Lists are the default presentation for issues, activity, members, tokens, and other repeated records.

Use a dense readable row treatment with a shared top and bottom boundary, dividers between rows, and enough vertical padding for scanning.

Do not introduce a new card-per-issue layout merely to make an index page feel more designed.

Issue rows should keep the issue key and title prominent, while status, priority, assignee, milestone, and relative time remain compact metadata.

Let important issue titles wrap when needed, and truncate only secondary text when the available width is genuinely constrained.

Every failure is reported the same way, through `web/src/ui/ErrorNote.tsx`: an Astryx error `Banner` with an icon, announced as an alert. A plain message is one line; with a title, the title says what happened and the message says what to do. A way to recover, such as Try again, sits at the end of the banner. No page writes its own red line of text for an error. Waiting is one line, a small spinner and a few words announced as a status (`LoadingState`), with nothing drawn around it, whether a page is loading or a button's action is in progress. A record or page that does not exist is an Astryx `Card` with the title, one line of explanation and a button back (`NotFoundState`).
Lists of things to open are Astryx `List`s whose rows are links, reached with Tab and opened with Enter.
Every list of records follows the same shape: an Astryx `List` with dividers and rules above and below, no rounded box. Team feed, Mentions, Unlinked PRs, the work log and Projects all use it; a row that holds its own links or controls is not itself a link. An unread mention leads with an ink dot, a heavier name and an Unread badge. Report tables are Astryx `Table`s inside a named, focusable scroll region.
The Sprints page draws every project's sprints on one shared calendar from the `lg` breakpoint up (`web/src/features/sprints/SprintStrip.tsx`): a row per project, a bar per sprint as wide as the sprint is long, month marks along the top and a line for today. A bar is a link to its sprint. State is drawn by shape as well as fill and named in the key above: solid ink is running, a dashed outline has not started, quiet grey is finished. Each link also reads out the sprint's dates and state. Below `lg` the page keeps a list per project, because a calendar needs width. Under the calendar, Running now gives one `Card` per project for its active sprint: the dates, a `ProgressBar` for how far through them it is, its milestones with done counts, and what comes next. The calendar says when; these say how it is going. A card is marked Behind, with an amber `Badge` and the numbers in words, when at least half the sprint's days have gone and the share of issues done is 25 points or more under the share of days gone. The count is every issue the sprint's own page lists: those under its milestones and its project's issues with no milestone yet. Cancelled issues are left out, and a sprint with no issues is not judged. The sprint's own page repeats the same reading under its title, from the same function (`sprintPace` in `web/src/features/sprints/sprintDays.ts`), so the two pages cannot disagree.
The Projects page is a grid of Astryx `Card`s, one per project: the open-issue count as the one large number and a link to those issues, the split by status beneath, then the current sprint and Archive or Restore. Archiving still confirms inside the card.

`web/src/features/issues/IssueList.tsx` and the issue groups in `web/src/features/sprints/SprintBoard.tsx` are the reference row treatments.
Both are Astryx `List`s whose rows are links to the issue. On the sprint page each status keeps its collapsible heading with a count, and the rows under it are 40px linked rows.

The Administration and Profile pages use the same parts: the section list beside each page is `web/src/ui/SectionNav.tsx`, an Astryx `List` of links with the current one selected and counts as supporting text; members, invitations and repositories are `List`s with dividers; fixed facts (slug, issue prefix, what each role can do) are `MetadataList`s; optional detail sits in a `Collapsible`; and the GitHub connection is a `Card`. Confirmations for removing a member or revoking an invitation still open inline under their row. The sign-in pages (Sign in, Check email, Confirm sign-in, Expired link, Invite, Recovery) keep the public split layout and hand the page to the task: the headline beside them is 48px, not the landing page's 71px, and the title (32px), one line of help and the action sit together as one block centred in the panel (`PublicAuthPage`). Each page has one main action at 48px; a fallback, such as asking for another link, is a secondary button. The longer tasks (onboarding, connecting the CLI, a new organisation) use the `expanded` form: a centred bordered surface without the landing content. The longer public pages (Onboarding, New organisation, CLI approval) follow the sign-in pages inside a centred bordered card: an account bar across the top (who is signed in, the way back, Sign out), then a 32px title with one line of help, then the work in a column no wider than it needs. On New organisation an invitation that is waiting leads; with none, creating leads. On Onboarding the connection status comes before the setup, and the four setup commands are an Astryx `CollapsibleGroup` with one step open at a time and a button that moves on to the next. CLI approval lays the decision out in order: check the code (the largest thing on the page, with who asked beneath it and the one sentence saying when to approve), then what approving allows as a short list, then Approve and Refuse. A repository request replaces the list with the choice of organisation and project. After the choice, the outcome is the page's title, Connected or Request refused, with the one next step set apart beneath it. When something is wrong the page says what happened and what to do about it, in a titled `ErrorNote`: a code that no longer works keeps the field so a new one can be entered, and a request that cannot go ahead at all (unrecognised, or a viewer in every organisation) takes over the title. A link that looks like a button is an Astryx `Button` with an `href`, never a hand-styled anchor; the one exception is Change / Link in the GitHub accounts table, which must clear private data before leaving the page. The public frame around the landing, sign-in and onboarding pages uses Astryx link `Button`s in its header and landing actions, and Astryx `Heading` and `Text` for its titles and copy. Its layout grid and the large landing headline stay in `landing.css`, because the headline scales fluidly with the window, which Astryx's type scale does not do. First-run onboarding shows its two steps in an Astryx `Stepper`, the suggested organisation in a `Card` with a `MetadataList`, and pending invitations as a `List`. The dashboard's prompt to connect an agent is a muted `Card` whose main action is an Astryx link button. In Profile > Agent config the four setup commands are an Astryx `CollapsibleGroup`: one step open at a time, each saying whether it is needed once per machine or once per repository, with a button that moves on to the next. Agent setup (Profile > Agent config and first-run onboarding) uses Astryx type for its numbered steps, a `TabList` to choose the instructions file, a `Card` with a `StatusDot` for the connection state, and a `List` of linked repositories. Its command and file blocks stay plain `pre` elements, because Astryx's `CodeBlock` drops the line breaks from the block's text and that text must be the file exactly as written. On Profile, API tokens are a `List`, a newly created token is shown once in a muted `Card`, and GitHub accounts by organisation is an Astryx `Table` with a row header per organisation.
The sprint page's title and its Milestones and Issues headings are Astryx `Heading`s. A milestone is an Astryx `ClickableCard`, one link to the milestone, holding its name, done count, a `ProgressBar`, the latest update and its footer. Each status group in the list is an Astryx `Collapsible` whose heading shows the label and count. The List | Board choice is a `SegmentedControl`. Astryx has no board, so the board's layout and drag-and-drop are Velvet's own, built from Astryx parts: each column is a muted `Card` with a `Heading` and count, each issue a `Card` inside the draggable list item, silent work carries a warning `Badge`, cancelled issues fold into a `Collapsible` under Done, and the move message is an Astryx `Toast` with Undo. A dashed outline around a column shows where a dragged card will land.
The sprint page is the one place issues may appear as cards: its Issues section offers a List | Board switch, the board choice is kept in `?view=board`, and `web/src/features/sprints/SprintKanban.tsx` owns the board.
The board has five columns in workflow order (Backlog, Todo, In progress, In review, Done), folds Cancelled under Done, and shows only the latest three Done cards until Show all is chosen.
Dragging a card and choosing from its status menu both change status, so the keyboard path is never weaker than the pointer path, and viewers see the board without either control.
A move applies at once, reports itself with Undo, and reverts with a plain message if the server refuses it.
Below the `lg` breakpoint (1024px) the switch is hidden and the grouped list is shown, because five columns are not readable in less width.

A list must have a useful accessible name, a predictable tab stop, stable row identity, and a direct keyboard and pointer activation path.

### Issue detail pages

Use `IssuePageLayout` with the narrative main column before the metadata rail.

At 1024px and above, the rail is 272px wide, remains sticky at 16px from the top, and is separated from the narrative by 32px.

Below 1024px, the columns collapse into one document order without hiding status, metadata, labels, evidence, or sub-issues.

The main column contains the issue header, description, edit form, unified timeline, and comment composer.

Ticket and milestone narratives include an Images section before the Timeline or Log.
Its dense rows pair a bounded, contained preview with the filename, relevance caption, uploader, agent/user source, and timestamp.
Images use protected same-origin API URLs, never public storage links.
Full-size viewing and download use ordinary keyboard-accessible links, and an unavailable preview keeps the caption and actions readable.
Only eligible writers see Delete, with an inline permanent-deletion confirmation, Cancel initially focused, and Escape returning focus to the trigger.
Loading, retry, empty, deletion failure, and deleting states must remain explicit, and large dimensions or long filenames must not widen the page.
Attached images are an Astryx list with dividers: a fixed thumbnail that opens the viewer, the file name, caption, who added it and its size, then Open in new tab, Download and Delete. Delete asks in the shared confirm dialog.
This release's empty state directs the person to their agent, because browser upload is not yet provided.

The rail contains status, metadata, labels, linked evidence, and sub-issues.

The metadata rail's Project and Milestone selects always agree, because a milestone belongs to one project through its sprint.
Milestone options are grouped in `optgroup`s labelled "Project · Sprint", active sprints first, and milestones of closed sprints are hidden unless the issue is already on one.
Choosing a milestone moves the issue to that milestone's project, and choosing a different project clears a milestone from another one, so the rail shows the saved result rather than a contradiction.
The issue's eyebrow names and links its project next to the key.
New-issue forms on the Issues page and the Dashboard offer the same two optional selects, and the Issues page defaults the project to the active project filter.

The issue status is an explicit user action, and linked pull requests are evidence rather than a status controller.

### Unlinked PRs and suggested issue links

`web/src/features/evidence/UnlinkedPRs.tsx` lists pull requests that matched no issue in the shared dense row treatment, followed by a "Notes that may belong on an issue" section that appears only when Jev has suggested an issue for a project note.
A suggestion sits inside its row as a quiet left-ruled line reading "Suggested issue:" with the issue key as a link and its title, so it is named as a suggestion in words rather than by color or a confidence number.
Its primary action names the destination, "Link to ENG-7" for a pull request or "File under ENG-7" for a note, beside a ghost "Dismiss", and the manual issue-key field stays for when the suggestion is wrong or missing.
Viewers see suggestions but no linking controls, pending actions say "Linking…" or "Dismissing…", and a suggestion handled elsewhere simply refreshes the list rather than raising an error.
Accepting never changes an issue's status.
The organisation switch lives under Administration > General, says in plain words what text is sent to TypeSafe, and says when the server has no key so "on" never implies suggestions are running.

### Settings pages

Settings should use clear sections, visible labels, and row-based records rather than dashboard-style cards.

Profile uses the full workspace width, with one concern per routed page: `/settings/profile/general`, `/settings/profile/github`, `/settings/profile/agent-config`, and `/settings/profile/tokens`, all under `/w/$slug`.
The shared header uses "Profile" as the eyebrow and the page name as the single `h1`, with "Page · Profile · Velvet" as the browser title.
Like Administration, its section list is a sticky `11rem` desktop column at `lg` and wrapping tabs below it, with real links and `aria-current="page"`.
The bare Profile address redirects to General, and old `#agent-config` bookmarks redirect to Agent config, preserving query strings.
Unknown sections show not found.
Leaving a section discards any one-time key and unfinished confirmation rather than restoring them with Back.
The token name field and agent setup stay at a readable width within the full-width content.

GitHub settings start with a compact "GitHub accounts by organisation" table of the signed-in person's memberships, showing each effective account, numeric GitHub ID, and organisation-link or global-fallback source.
Organisation names link to their own GitHub settings and the current organisation is labelled explicitly.
Rows load and retry independently, never treating a failed request as an unlinked account or guessing that an unavailable global fallback is effective.
The semantic table wraps long names within the mobile viewport and shares the existing scoped identity query cache, so removing a link or unlinking the global account refreshes the overview too.
Each organisation row provides Link or Change and, for an organisation override, Remove directly in an Actions column.
The link source remains beside the account, and a compact Global default row keeps shared-profile linking and removal available without a second settings section.
Confirmation expands across the table width beneath the selected row, names its organisation, and explains that removing an override restores the fallback if available while preserving existing evidence.
Removing the global default explicitly warns about fallback changes across organisations and leaves organisation-specific links alone.
Confirmation initially focuses Cancel and Escape restores focus to that row's trigger; pending or failed identity rows do not offer destructive actions.
Brief table guidance explains that GitHub is optional and that account selection applies only to authorisation, not workspace switching.
GitHub App repository access is a distinct administrator concern under Repositories, with a warning that synced evidence is shared with the Velvet organisation even if members cannot open the private GitHub links.

Agent config sits between GitHub and API tokens in the section list.
It never shows a secret: `velvet login` grants setup access after browser consent, then terminal `velvet init` mints each repository's project key.
The page starts with a live status region listing the repositories linked to the organisation, with each key's project and last use, and polls until one has been used.
Below it, "Connect a repository" shows the install command, `velvet login --server`, terminal `velvet init --server`, and a tab list of the instructions block for `AGENTS.md`, `CLAUDE.md`, and a Cursor rule.
The block names no project or key, so it is identical for every repository and safe to commit.
An organisation without an active project shows an inline form to create one in place of the steps, because `velvet init` needs a project to pick.
Viewers see a note that they cannot connect a repository that writes, and no steps.
Logging out with `velvet logout` revokes the saved login and its child repository keys. Individual keys can be revoked under API tokens.

`/cli/approve` is where `velvet login` sends the browser.
It uses the public auth layout, asks for the code if the link did not carry it, shows the code in a large monospace line to compare with the terminal, and offers Approve login and Refuse.
Consent explains setup access and does not fetch or select organisations or projects. Terminal `velvet init` selects or creates those after login.
Signing in preserves only a validated local approval return path, including when the email link opens in a fresh tab.

Administration uses the wider workspace content width for organisation settings, invitations, member rows, GitHub connections, and the separated danger section.

Administration is a small settings area with one page per concern, each at its own address: `/admin/general`, `/admin/members`, `/admin/invitations`, `/admin/repositories`, and `/admin/danger`.
The bare `/admin` address, which older links and GitHub's return used, opens General, and GitHub's install return now lands on Repositories.
An unknown page is not found rather than an empty Administration page.
`AdminLayout` owns the shared header, with "Administration" as the eyebrow and the page name as the one `h1`, the admin check, and the section list, so no page can render or fetch for a non-admin.
Each page's browser title is "Page · Administration · Velvet".

At `lg` and above, the section list sits in a sticky `11rem` column beside the page, and below `lg` it wraps into tabs above the page so every section stays visible without sideways scrolling.
Its links are real routes with `aria-current="page"` on the current one and live counts for members, pending invitations, and connected repositories, read from the same cache the pages use so moving between pages does not refetch.
The sidebar's Administration link stays selected on every Administration page, and the command palette offers Members, Invitations, and Repositories directly.

Member rows show the avatar, name, email and GitHub login, and a "You" tag, sorted admins first.
A "What each role can do" disclosure explains the roles, and the invite form describes the chosen role below the controls.
The only admin cannot be removed or leave, and the row says why, so the server's last-admin refusal is never the first explanation.

Invitations show when they expire, and one due within a day says "Expires soon" in the stale colour.
Sending or resending an invitation, and saving the organisation name, confirm in a polite live region.

Repositories start with a bordered status line that pairs a coloured dot with words and shows when repositories last synced.
Each repository row has a project select, which is where untracked pull requests, commits, and agent entries from that repository are filed.

The Danger zone is its own page, last in the section list and named in the destructive colour, with the delete form inside a `border-blocked` surface.

Keep destructive settings visually and structurally separate from ordinary settings.

Do not reveal a secret again after the one-time display that the existing API-token flow provides.

### Onboarding

`/onboarding` uses the public auth layout, outside the workspace shell, because a new person has no organisation to put a shell around.

It has two steps shown as a numbered progress list with `aria-current="step"`: create the organisation, and connect an agent.

The organisation step shows the suggested name, address, and ticket prefix as a preview with one primary action, and only reveals editable fields on "Change these", so the common path is a single click.

Pending invitations appear above the create form, because joining an existing organisation is usually what an invited person wants.

The connect step shows the same "Connect a repository" steps and live linked-repositories status as Agent config, with arrow-key navigation between the instruction files.

Once an organisation exists, the screen offers a link to the dashboard and says that Profile > Agent config is where to connect more repositories later.

The dashboard shows a dismissible connect card until an agent connects, and it links to Profile > Agent config rather than back to onboarding.
The command palette also offers an Agent config command, so the section stays reachable after the card is dismissed.

The connection status counts only keys bound to a project in this organisation, so a personal token or another organisation's repository does not report this one as connected.

## Components and interaction rules

Prefer the existing primitives before adding a local variant.

`web/src/ui/Button.tsx` provides `primary`, `secondary`, `danger`, and `ghost` variants.

Primary actions use paper-colored text on an ink fill, secondary actions use a neutral border, ghost actions remain quiet, and danger actions use the blocked semantic color only for destructive intent.

`web/src/ui/ConfirmDialog.tsx` is the question asked before anything is removed, revoked, archived, deleted or closed: an Astryx alert dialog whose title asks, whose description says what will happen, and whose action button repeats the verb. A failure replaces the description and the dialog stays open for a retry; Escape does not abandon an action in flight; focus returns to the control that asked. Do not confirm inline in a row. Deleting an organisation is the exception: it stays a type-the-name form.
`web/src/ui/FormDialog.tsx` is the create form (New issue, New sprint, New project): an Astryx dialog over the page, so the page behind keeps its place. Its title names the dialog, one line says what the form makes, and the close button, Escape and a successful save all close it; a click on the backdrop does not discard typing. The old hand-drawn `ui-surface` panel is gone; use an Astryx card or dialog.
`web/src/ui/EmptyState.tsx` is the shared empty, no-data, and no-results structure. Its full form is Astryx's empty state inside an Astryx card, the same card the not-found state uses. Its `compact` form is one muted line for narrow rails and for sections stacked on a detail page, so a new issue does not open as a column of large boxes.

A page keeps its heading while it loads and when loading fails, so the person always knows where they are and can retry in place.

`web/src/ui/StatusBadge.tsx` names every issue status in text and uses color only as reinforcement.

`web/src/ui/Avatar.tsx`, `web/src/ui/Markdown.tsx`, and `web/src/ui/RelativeTime.tsx` are the shared identity, content, and timestamp primitives.

Use the existing form patterns in `web/src/features/work/CoreForms.tsx` with a visible label above each control, native validation where appropriate, and a clear submit state.

Form controls come from `web/src/ui/fields.tsx`, which draws them with Astryx: `TextField`, `TextAreaField`, `SelectField`, and `CheckboxField`. A dropdown is Astryx's pop-up list and not a native select, so the browser cannot mark it required; a form that needs a choice checks it on submit and shows the reason under the control. Date and file inputs stay native inside `NativeField`. Each field keeps a 44px touch target below the `sm` breakpoint.

The Issues filter toolbar keeps search, status, assignee, project, priority, and Clear filters as one semantic group.

Each filter shows a one-word label above its control and carries a fuller accessible name, such as "Filter by status", and Clear filters appears only while something is filtered.

The Issues page opens on open statuses, so finished work never leads the list; "All statuses" brings done and cancelled issues back and is written to the address as `status=all`.

An issue row keeps its labels beside the title and its date on one line, so a row is a single line unless the title itself wraps.

The Issues list reads as status groups in workflow order (In progress, In review, Todo, Backlog, Done, Cancelled). Inside a group the most urgent priority leads (P1 to P4, then issues with none set). The API orders the pages that way, so a group never appears out of sequence across pages, and a group shows its count only when the whole result fits on one page. A row under a status heading drops its status badge and keeps the status in its accessible name; a list filtered to one status has no headings, so its rows keep the badge.

The Issues page is the pattern for page layouts on Astryx. The page title and section titles are Astryx `Heading`s through `PageHeader` and `SectionHeader`. Each status group is an Astryx `List` (dividers, balanced density, flush edge) whose header is a level 3 `Heading` with the count beside it as supporting `Text`; each issue is a `ListItem` with an `href`, so the whole row is one link. The columns inside a row stay Velvet's grid so keys, titles, priority, assignee and date line up across groups. Labels are small `Token`s. Paging is Astryx's compact `Pagination` with the page number announced beside it. Links inside Astryx components route through `web/src/app/AppLink.tsx`, set once with `LinkProvider`.

Issue detail and the Milestone page follow it too. A milestone's issues, in its narrow side panel, are an Astryx `List` of linked rows from `IssueList`: key, full title, then status beneath, because the column is too narrow to put status beside the title. On Issue detail: the title is a level 1 `Heading` under a supporting-text line with the key and project. The sections of the page and of its side panel use `PanelHeading`, a second-level heading drawn at 16px semibold, in sentence case rather than small capitals. Read-only field names are label `Text`, read-only labels are `Token`s, and sub-issues are a `List` of linked rows. Headings written inside a description are 18px at most, so they never outrank the page title.

The Dashboard follows it: My open issues is one `List` per milestone with a level 3 `Heading`, each issue a linked `ListItem` with its status badge at the end. My recent activity is a `List` whose rows are not links, because each activity row carries its own links to the issue, milestone or pull request it names.

Every active issue filter is written to the address (`q`, `status`, `assignee`, `project`, `priority`) so a reload or a shared link keeps the same view.

The current toolbar stacks controls below `md`, uses two columns at `md`, and uses a wider search field plus three compact filters and a clear action at `xl`.

A clear action is disabled when no filter is active and must reset every filter when invoked.

Preserve drafts when a request fails, as `CommentComposer` does, and explain how to retry.

The issue timeline is an Astryx `List`: a comment leads with its author's avatar and an event with a small dot in the same column, so every line of text starts at the same edge, and each row ends with its time. Reply is a ghost `Button` under the comment it answers.
`CommentComposer` is a `SegmentedControl` for Write and Preview above an Astryx text area, with attached files shown as removable `Token`s.
`CommentComposer` offers Write and Preview plus a Diagram action that inserts a fenced `mermaid` sample at the selection without discarding the surrounding draft.
The shared `Markdown` renderer displays Mermaid fences in comments and replies, including agent-authored comments, with the same Diagram / Source, Copy source, and Expand controls.
Diagram / Source is Astryx's `SegmentedControl`, a choice of one view, and Expand opens Astryx's `Dialog`, which returns focus to Expand when it closes.
A diagram's box takes the height the diagram needs at the width it has, between 10rem and 30rem, and never draws it larger than its own size; Expand shows a diagram that is still too small to read.
A screenshot under a comment is at most 15rem wide and 15rem tall, so a tall capture does not push the conversation apart.
Pressing any image thumbnail opens it full size over the page in Astryx's `Lightbox`, with zoom, and with previous and next when the set holds more than one. The Images section keeps Open in new tab and Download as text links beside each image.
Rendering is lazy and local, with a flat monochrome theme that follows the system color scheme.
Expanded diagrams use a native dialog with Escape dismissal and focus returned to Expand.
Loading and syntax errors are explicit, and a failed diagram always keeps its source readable.
Diagrams are limited to 20,000 characters and 500 edges, do not accept configuration blocks or external images, and display sanitized SVG inside a script-free, network-blocked sandbox.
Ordinary code fences keep their existing presentation.

Do not use `transition: all`.

Name the exact animated properties and keep high-frequency or keyboard-triggered actions instant where animation would add delay.

Use a static label, icon, color, or structure for every state so motion is never the only feedback.

## Responsive and mobile rules

Design from the narrow layout first, then add the `sm`, `md`, `lg`, and `xl` enhancements already used by the source.

Keep the desktop sidebar out of the mobile flow and keep the mobile bottom bar out of the desktop flow, as `Shell.tsx` does.

At narrow widths, stack filters and forms, allow metadata to wrap below the title, and keep the issue key and title visible.

At wide widths, use the available space for readable columns rather than adding decorative cards or oversized empty gutters.

Avoid nested horizontal scrolling for ordinary issue rows.

If a row has more metadata than fits, move low-priority metadata below the title instead of hiding the issue identity or action.

Verify both 1280x900 desktop and 390x844 mobile because those are the viewports exercised by `e2e/tests/issues.spec.ts`.

## Accessibility, focus, contrast, and motion

Use semantic landmarks, one clear page heading, correctly associated labels, and native controls before adding ARIA.

Keep the visible focus ring from `index.css` and never replace it with a color-only hover treatment.

The issue status picker (`StatusSelect`) is an Astryx Selector drawn as a quiet button, with each status's dot beside its name; Astryx owns its pop-up, placement and keyboard, so do not hand-build a menu where a Selector or DropdownMenu fits.

Do not make keyboard users traverse a different information architecture from pointer users.

Validate at least 4.5:1 contrast for normal text, 3:1 for large text and meaningful non-text boundaries, and both light and dark color-scheme modes.

Check disabled text and focus indicators separately because opacity can erase otherwise valid contrast.

Disabled buttons keep `grey-700` text and show a dashed border instead of fading, so the label stays readable. When a control is unavailable for a reason the person can act on, say the reason in visible text next to it, not only in a tooltip.

Priority is shown as P0 to P4. The API and CLI define 0 as none, so pickers label it `P0 (none)`. The product does not define an order for 1 to 4, so the interface does not claim one.

Aim for 44px by 44px touch targets on touch surfaces and never ship a target below 24px by 24px without the applicable spacing exception.

Below `sm`, `.ui-button` and `.ui-control` are at least 44px tall. That rule in `web/src/index.css` is deliberately outside the cascade layers so a call-site `min-h-*` utility cannot shrink a phone target.

The mobile navigation uses `min-h-12`, or 48px, while several desktop controls are visually compact at 28px to 32px, so measure the actual hit area instead of assuming compliance.

Respect `prefers-reduced-motion: reduce` by removing nonessential transitions and animations without removing state or feedback.

Use the existing 150ms to 160ms menu and button timings only when they clarify pointer interaction, and skip them for keyboard-opened menus.

Use ease-out for entrances and exits, never ease-in for ordinary UI feedback, and never animate from `scale(0)`.

## States and destructive actions

Every data surface must define loading, success, error, empty, no-results, disabled, and saving behavior before implementation.

Loading copy should use a status announcement where the user needs to wait.

Errors should be visible text with an alert role where appropriate and a retry path that does not discard user input.

Successful mutations should update the visible record or expose a concise status announcement rather than relying on animation alone.

Empty data and filtered no-results states must explain the next useful action without pretending that a filter removed the underlying data.

Pending controls must be disabled only as long as necessary and must expose a saving, loading, or revoking label.

Use an inline second confirmation step for destructive actions, matching the member removal, token revocation, and organisation deletion patterns in the current source.

Explain the consequence before the final action, keep Cancel available, and keep the confirmation visible when a request fails.

Typing an organisation slug is required for organisation deletion, and equivalent high-impact actions should use an equally deliberate confirmation boundary.

A pull request merge, evidence attachment, branch name, or deployment event never authorizes an automatic issue status change.

## Resolved deviation: Issues page

`web/src/features/issues/IssuesPage.tsx` now renders issues as a dense row-based list with dividers between rows, bounded above by the section heading's rule and below by the list's own, so no two rules stack.

The rows preserve the issue links, filtering behavior, count, create flow, loading state, error retry, empty state, no-results state, and accessible names while exposing status, priority, assignee, and milestone metadata responsively.

This resolves the Issues-page card-layout deviation only.

## Validation and review protocol

1. Read the relevant route, data contract, existing page, shared primitive, and test before changing UI.

2. Record whether each observation is existing behavior, desired behavior, or not verified.

3. Reuse source tokens and primitives before adding a new class, component, color, breakpoint, or interaction pattern.

4. Test the main path and every defined loading, error, empty, no-results, disabled, saving, focus, keyboard, and reduced-motion state.

5. Run the focused web tests, typecheck, lint, and build that cover the changed surface.

6. Run the relevant Playwright test against the real Compose stack rather than treating mocked unit tests as end-to-end proof.

7. Review screenshots at 1280x900 and 390x844 for hierarchy, row density, wrapping, focus, navigation, and horizontal overflow.

8. Check both color schemes and keyboard-only navigation before calling the work complete.

9. Report any browser, reduced-motion, contrast, or production-stack check that could not run as Not verified.

10. Inspect the final diff and confirm that documentation or UI changes did not touch unrelated files.

### Source references

- [Repository overview and commands](README.md)
- [Web package scripts](web/package.json)
- [Web global tokens](web/src/index.css)
- [Shared shell](web/src/app/Shell.tsx)
- [Issue index page](web/src/features/issues/IssuesPage.tsx)
- [Shared issue list](web/src/features/issues/IssueList.tsx)
- [Issue detail page](web/src/features/issues/IssuePage.tsx)
- [Sprint issue rows](web/src/features/sprints/SprintBoard.tsx)
- [End-to-end issue coverage](e2e/tests/issues.spec.ts)
- [Browser test commands](e2e/README.md)
