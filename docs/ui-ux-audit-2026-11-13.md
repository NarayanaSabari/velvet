# Web UI/UX audit, 13 November 2026

Scope: the React SPA in `web/`, audited against [`design.md`](../design.md).
Nothing in the product was changed. This document reports findings only.

## How it was checked

- Read every route-level feature, the shell, the shared primitives and `index.css`.
- Rebuilt the disposable e2e stack from the current tree and drove it with Playwright (Chromium).
- Seeded a throwaway organisation with projects, sprints, milestones, nine issues, labels, comments, a mention, an invitation, a repository and three pull requests, then removed it.
- Measured 158 page renders: 23 product pages at 1280x900 and 390x844 in light and dark, 7 public pages in the same four combinations, plus an empty organisation and a viewer account.
- Re-measured every product page for horizontal overflow at 320, 640, 700, 768, 1024 and 1720px.
- Ran one keyboard and interaction pass: tab order, skip link, command palette, menus, forms, confirmations, a forced load error, a forced comment failure and slow loads.

Each finding is marked **Measured** (a number from the browser), **Seen** (a screenshot) or **Code** (read in source, not exercised).

## Summary

The foundations are sound. The two standard viewports have no horizontal overflow on any page, every page has one `h1` and a correct title, focus is always visible, and dark mode has no contrast failures on enabled text.

The problems are concentrated in three places:

1. The Issues list is unreadable at common laptop widths.
2. The sprint board breaks between 640 and about 1024px.
3. Touch targets on phones are mostly below the 44px the design standard asks for.

| Severity | Count |
| --- | --- |
| Critical | 1 |
| High | 4 |
| Medium | 11 |
| Low | 9 |

## Critical

### C1. Issue titles collapse to one letter per line at 1280px

**Measured, Seen.** At 1280x900 the first issue row is 672px tall and the title is set one or two characters per line. Nine issues make a page 7,244px tall.

Cause: the `xl` row grid in `web/src/features/issues/IssuesPage.tsx` is
`5rem minmax(0,1fr) 8rem 3rem 11rem 12rem minmax(0,10rem) 5rem` with a 16px gap.
The fixed tracks and gaps need 976px. The row has 992px at 1280, so the title track gets 16px. The labels track takes its full 10rem even when an issue has no labels.

The layout only recovers when the title track has real room: about 456px at 1720. Everything from 1280 to roughly 1500px wide is affected, which covers most laptops. Below 1280 the two-line `md` layout is used and reads well.

`e2e/tests/issues.spec.ts` runs at 1280 and does not catch this, because the page does not overflow sideways. It grows downwards.

Fix direction: give the title a minimum width (for example `minmax(16rem,1fr)`), let labels share the title cell or drop to `auto`, or move the eight-column layout to `2xl`. Add an assertion that a title row is no taller than a few lines.

## High

### H1. The sprint board is offered at widths where it cannot work

**Measured, Seen.** The List | Board switch appears from 640px, and the board always has five equal columns.

| Viewport | Column | Card | Page overflow |
| --- | --- | --- | --- |
| 640 | 70px | 52px | 24px |
| 700 | 82px | 64px | 12px |
| 768 | 96px | 78px | 0 |
| 1024 | 147px | 129px | 0 |
| 1720 | 280px | 262px | 0 |

At 768 titles break mid-word ("disapp / ears"), column headings wrap, and each card's status control is wider than the card and overlaps its neighbour. At 640 and 700 the document scrolls sideways, which `design.md` forbids.

Fix direction: raise the board threshold in `useWideEnoughForBoard` (`SprintBoard.tsx`) to `lg`, or let the board scroll horizontally inside its own region with a column minimum near 14rem.

### H2. Phone touch targets are mostly under 44px

**Measured.** At 390x844 a large share of controls are shorter than 44px:

| Page | Under 44px |
| --- | --- |
| Issue detail | 18 of 36 |
| Administration, Members | 13 of 20 |
| Administration, Invitations | 11 of 18 |
| Profile, GitHub | 10 of 17 |
| Sprint page | 9 of 29 |
| Unlinked PRs | 9 of 17 |
| Issues | 8 of 24 |
| Dashboard | 8 of 20 |

Specific cases:

- All ten items in the mobile More menu are 36px tall.
- The shared `Button` is about 34px tall, and only some call sites add `min-h-10` or `min-h-11`.
- Forms in `CoreForms.tsx` use 30px inputs and selects at every width.
- The board's move notice has an Undo target of 35x21px and a dismiss target of 9x21px.
- "New project" in agent setup and the board's "Cancelled" disclosure are 21px tall.

Fix direction: put the mobile minimum height in `buttonClassName` and one shared control class, so pages stop opting in one at a time.

### H3. Issue filters are lost on reload and cannot be shared

**Measured.** After choosing a status the address stayed `/w/<slug>/issues`, and a reload reset the filter to "All statuses". Search, assignee, project and priority behave the same way.

The page already reads `?project=` and `?status=open` on first load, so links into it work, but the page never writes its own state back. Back, reload and "send me that list" all lose the filter. The sprint page already keeps `?view=board` in the address, so the pattern exists.

### H4. Loading and error states remove the page heading

**Measured, Code.** While the dashboard request fails, the page has no `h1` and shows only "Could not load the dashboard." with Try again. A slow Sprints load also has no `h1`.

Dashboard, Sprints, Sprint, Mentions, Unlinked PRs, Issue and Milestone return `LoadingState` or `ErrorState` before rendering `PageHeader`. Issues, Projects, Team feed, Reports and Work log keep the header and load inside it, which is the better pattern. The result is a layout jump on every navigation to the first group, and a page with no heading for screen reader users while it waits.

A viewer who opens an Administration address has the same problem: "Admin access required" is a paragraph inside an empty-state box, with no `h1` and no way back.

## Medium

### M1. Supporting text on grey surfaces is below 4.5:1

**Measured.** `grey-500` (#737373) on `grey-100` (#f5f5f5) is 4.35:1 in the light scheme. It appears on 24 of the measured pages: the filter labels on Issues and Team feed, every `EmptyState` message, and table headings on Reports.

`design.md` already records this exact pair as failing and moved the sidebar to `grey-700`. The same change has not reached `EmptyState.tsx`, the filter toolbars or the report tables. Dark mode passes.

### M2. Disabled buttons fall to 2:1

**Measured.** `disabled:opacity-40` gives 2.07:1 for a disabled danger button, 2.82:1 for "Clear filters" and 2.85:1 for "Add label" in light, and 2.01:1 for the danger button in dark.

Disabled controls are exempt from the contrast rule, but `design.md` asks for them to be checked because opacity can erase a valid colour. The only-admin "Leave" button is the important case: it is disabled for a reason the person needs to read, and its explanation is a `title` tooltip that touch and keyboard users never see.

### M3. The edit panel opens far from its button

**Measured.** "Edit issue" sits at the top of the page (header bottom at 88px). The panel it opens starts at 780px, under the description and Images section, and focus stays on the button.

On an issue with a long description the form opens off screen with no sign that anything happened. Milestones share the layout. Opening the form in place of the description, or moving focus to its first field, would fix both.

### M4. Status is the last thing on a phone

**Measured.** At 390px the status control starts 1,890px down the issue page, after the description, images, timeline and comment box. Assignee and priority follow it.

`design.md` asks for the narrative before the rail, and that order is right on wide screens. On a phone the most frequent action on an issue needs the longest scroll. A compact status row under the title on narrow screens would keep the documented order for everything else.

### M5. Several pages have no selected navigation item

**Measured.** `design.md` requires `aria-current="page"` on exactly one link.

- Desktop: the Milestone page selects nothing. Sprints is the natural parent.
- Mobile: Projects, Reports, Team feed, Unlinked PRs, Work log and Milestone select nothing. They live under More, and the More button carries no selected state.
- Issue detail marks the project link in the eyebrow as the current page. `NavLink` strips the query from `/issues?project=web` and then prefix-matches it against `/issues/AUD-1`.

### M6. The command palette is incomplete and repeats itself

**Code, Seen.**

- No command for Projects or My work log, although both are in the sidebar.
- Issue results show the title twice: the label is "KEY title" and the detail is the title again.
- Each search downloads every issue in the organisation and filters in the browser (`listAllWorkspaceIssues`). That will slow down as an organisation grows.
- The page behind the open dialog is not inert. Tab stayed inside for the four presses tested, but the full cycle was not checked.

### M7. Two generations of form controls

**Measured, Code.** `CoreForms.tsx` uses its own `inputClass`: 30px tall, no `ui-control`, no larger mobile size. The filter toolbars, Projects, Administration and Profile use `ui-control min-h-10 md:min-h-8`. The New issue form and the filter bar directly below it therefore have visibly different control heights on the same screen.

The New issue form also takes no focus when it opens (the active element stayed on `body`), so a keyboard user has to tab into it.

### M8. Priority has no meaning attached

**Code, Seen.** Rows show "P1". The New issue and Edit forms offer bare "0" to "4". The read-only rail prints "P1 1", the same number twice. Nothing says whether P0 is the most or the least urgent.

### M9. Raw machine values in the interface

**Seen.** The sprint header reads "2026-11-01 to 2026-11-30 · active". Sprint rows, milestone due dates and the dashboard's "ends 2026-11-30" use the same raw form, and sprint state is the lower-case API value. The Work log already formats dates for people ("Monday, 21 September"), so the two styles sit side by side.

### M10. Empty states dominate a new issue

**Code, Seen.** A new issue can show four large grey `EmptyState` boxes at once: description, images, timeline and sub-issues, plus a fifth for linked PRs. Each has 40px of vertical padding, and two sit in the 272px rail. A one-line muted sentence would suit the rail better and keep the box for whole-page emptiness.

### M11. Report tables hide columns on phones without a cue

**Seen.** Report tables have a 36rem minimum width and scroll inside their container. At 390px the third column heading is cut mid-word and nothing shows that more columns exist.

## Low

- **L1. Shortcut hint.** The comment box always says "⌘↵ to post". The handler accepts Ctrl as well, and the shell already picks "Ctrl K" on other platforms. **Code.**
- **L2. Team feed person filter.** It offers only "Everyone" and the signed-in person, so nobody else's activity can be isolated. **Code.**
- **L3. Dashboard issue rows.** Only the short key is a link. The title is plain text, so the click target is a few characters wide. **Code.**
- **L4. Labels.** Every label has the same grey dot. A colour is stored (always `#111111`) but never shown, so the dot carries no information. **Seen, Code.**
- **L5. Confirmation focus.** Removing a member and archiving a project leave focus on the trigger. Deleting an image and removing a GitHub link move focus to Cancel, as `design.md` describes. **Measured.**
- **L6. Heading styles drift.** `PageHeader` uses medium weight with tight tracking. Issue and Milestone titles use regular weight. Section headings come in three styles: small upper-case, 16px medium, and 16px regular. **Code.**
- **L7. Token drift.** The command palette hard-codes `rounded-[6px]` and `rounded-[8px]` and builds its own primary button instead of using `Button`. `ui/mermaid.ts` repeats the palette as hex values. **Code.**
- **L8. Board status menu.** On a card low in a column the menu ran to 933px in a 900px viewport, so the last options need a scroll. **Measured.**
- **L9. Console noise.** Every issue with a diagram logs "Blocked script execution in 'about:srcdoc'". The sandbox is working as intended, but the error hides real ones. **Measured.**

## Gaps in the product, not defects

These are missing capabilities seen while reading the code. They may be deliberate.

- Comments cannot be edited or deleted from the web app, although "edited" and "Comment deleted" states are rendered.
- Issues cannot be deleted or moved to another parent.
- Mentions can only be marked read all at once.
- Switching organisation does a full page reload.

## What works well

- **No overflow.** All 158 measured renders at 1280 and 390 fit their viewport, and so does every product page at 320px, with a 96-character unbroken title in the data.
- **Structure.** One `h1` per loaded page, no skipped heading levels, correct browser titles on every route, no unlabelled form fields.
- **Keyboard.** All sixteen tab stops from a cold load showed the 2px ink focus ring. The skip link lands on the main region. Ctrl+K opens the palette and Escape returns focus to where it was.
- **Dark mode.** No enabled text fails contrast in the dark scheme.
- **Failure handling.** A forced comment failure kept the draft and said so. A forced load failure offered Try again.
- **Empty organisation.** Every page explains itself and points to the next step. Sprints sends a project-less organisation to Projects.
- **Destructive actions.** All use an inline second step with the consequence stated. Organisation deletion needs the slug typed.
- **Status without colour.** Every status is named in words.
- **Public pages.** Landing and sign-in hold together at both viewports with the form in view.

## Not verified

- Safari, Firefox and real phones. Only Chromium was used.
- Screen readers. Roles and names were read from the DOM, not listened to.
- Drag and drop on the board, the onboarding flow, accepting an invitation, CLI approval while signed in, connecting GitHub, and issues with images attached.
- Motion. Every run used reduced motion, so transitions were not observed.
- Performance and the web unit tests.

## Suggested order of work

1. C1, the Issues row grid. A small change that fixes the most used page.
2. H1, the board threshold.
3. H2 and M7 together: one shared control and button height.
4. M1: move muted text on grey surfaces to `grey-700`.
5. H3: write filters to the address.
6. H4: keep `PageHeader` mounted while loading or failing.
7. The remaining medium items, then the low ones.
