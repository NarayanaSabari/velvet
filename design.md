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

The profile page fills the workspace width like its siblings, and only its API-token name field keeps a `max-w-2xl` (672px) measure.

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

The sidebar navigation is grouped under visible section labels: Workspace for planning surfaces and Administration, Activity for the team feed, mentions, and unlinked pull requests, and Across organisations for the work log.

Each navigation link pairs a 16px icon from `web/src/ui/Icon.tsx` with its text label, and the icon never replaces the label.

The current page is lifted onto a bordered paper surface with medium weight and ink icon, so selection is carried by shape and weight rather than by fill alone.

Supporting text on the grey sidebar surface uses `grey-700`, because `grey-500` on `grey-100` falls below 4.5:1 in the light scheme.

Below 640px, the shell shows a workspace header with a 44px Search button and a fixed five-slot bottom navigation with icons, labels, and a safe-area inset.

The current mobile tabs expose Dashboard, Issues, Sprints, Mentions, and More, with the remaining links in the More menu.

Active navigation must expose `aria-current="page"` on exactly one link and a visible non-color-only selected treatment.

Page content must remain `min-w-0` inside the shell so long titles and controls cannot widen the document.

### List and index pages

Lists are the default presentation for issues, activity, members, tokens, and other repeated records.

Use a dense readable row treatment with a shared top and bottom boundary, dividers between rows, and enough vertical padding for scanning.

Do not introduce a new card-per-issue layout merely to make an index page feel more designed.

Issue rows should keep the issue key and title prominent, while status, priority, assignee, milestone, and relative time remain compact metadata.

Let important issue titles wrap when needed, and truncate only secondary text when the available width is genuinely constrained.

`web/src/ui/List.tsx` provides the keyboard-navigable listbox pattern with `j`, `k`, Arrow keys, and Enter.

`web/src/features/issues/IssueList.tsx` and the issue groups in `web/src/features/sprints/SprintBoard.tsx` are the reference row treatments.

A list must have a useful accessible name, a predictable tab stop, stable row identity, and a direct keyboard and pointer activation path.

### Issue detail pages

Use `IssuePageLayout` with the narrative main column before the metadata rail.

At 1024px and above, the rail is 272px wide, remains sticky at 16px from the top, and is separated from the narrative by 32px.

Below 1024px, the columns collapse into one document order without hiding status, metadata, labels, evidence, or sub-issues.

The main column contains the issue header, description, edit form, unified timeline, and comment composer.

The rail contains status, metadata, labels, linked evidence, and sub-issues.

The issue status is an explicit user action, and linked pull requests are evidence rather than a status controller.

### Settings pages

Settings should use clear sections, visible labels, and row-based records rather than dashboard-style cards.

Profile uses the full workspace width for identity, GitHub linking, and API-token rows, with the token name field kept to a readable width.

Administration uses the wider workspace content width for organisation settings, invitations, member rows, GitHub connections, and the separated danger section.

Keep destructive settings visually and structurally separate from ordinary settings.

Do not reveal a secret again after the one-time display that the existing API-token flow provides.

### Onboarding

`/onboarding` uses the public auth layout, outside the workspace shell, because a new person has no organisation to put a shell around.

It has three steps shown as a numbered progress list with `aria-current="step"`: create the organisation, create an API key, and connect an agent.

The organisation step shows the suggested name, address, and ticket prefix as a preview with one primary action, and only reveals editable fields on "Change these", so the common path is a single click.

Pending invitations appear above the create form, because joining an existing organisation is usually what an invited person wants.

The connect step shows the key once, the MCP URL, and a tab list of per-agent setups with arrow-key navigation, followed by a live status region that announces when the agent first connects.

Every step offers a way to skip to the dashboard, where a dismissible connect card remains until an agent connects.

## Components and interaction rules

Prefer the existing primitives before adding a local variant.

`web/src/ui/Button.tsx` provides `primary`, `secondary`, `danger`, and `ghost` variants.

Primary actions use paper-colored text on an ink fill, secondary actions use a neutral border, ghost actions remain quiet, and danger actions use the blocked semantic color only for destructive intent.

`web/src/ui/EmptyState.tsx` is the shared empty, no-data, and no-results structure.

`web/src/ui/StatusBadge.tsx` names every issue status in text and uses color only as reinforcement.

`web/src/ui/Avatar.tsx`, `web/src/ui/Markdown.tsx`, and `web/src/ui/RelativeTime.tsx` are the shared identity, content, and timestamp primitives.

Use the existing form patterns in `web/src/features/work/CoreForms.tsx` with a visible label above each control, native validation where appropriate, and a clear submit state.

The Issues filter toolbar keeps search, status, assignee, priority, and Clear filters as one semantic group.

The current toolbar stacks controls below `md`, uses two columns at `md`, and uses a wider search field plus three compact filters and a clear action at `xl`.

A clear action is disabled when no filter is active and must reset every filter when invoked.

Preserve drafts when a request fails, as `CommentComposer` does, and explain how to retry.

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

Preserve the listbox keyboard contract and return focus to a trigger when a custom menu closes, as `StatusSelect` does.

Do not make keyboard users traverse a different information architecture from pointer users.

Validate at least 4.5:1 contrast for normal text, 3:1 for large text and meaningful non-text boundaries, and both light and dark color-scheme modes.

Check disabled text and focus indicators separately because opacity can erase otherwise valid contrast.

Aim for 44px by 44px touch targets on touch surfaces and never ship a target below 24px by 24px without the applicable spacing exception.

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

`web/src/features/issues/IssuesPage.tsx` now renders issues as a dense row-based list with shared top and bottom boundaries and dividers between rows.

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
