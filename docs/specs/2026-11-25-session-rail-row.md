# Session rail: one row shape, no search box

Date: 2026-11-25 · Scope: UI change · Branch: `feat/session-rail-views` · PR 2 of the rail redesign

The redesign has three steps. This is the first: how a row is drawn. The view switch (Mine · State · Project) comes with
the State view in the next PR, so no switch ships with only one working option.

## Problem

`SessionRail.tsx` draws rows whose two lines hold different things from row to row:

- What you owe ("review +2", "merge") sits on the name's line and cuts the name short; five characters of what is left
  are the `feat/` prefix.
- The second line is the project, a strip of `#4499 #4498 …` pills, or both. Four pills push the project out. The numbers
  say nothing about where each PR stands.
- "+7 older" is a link at the bottom, not part of the list.
- The search box repeats the dashboard's search and the Ctrl+P switcher.

## Behaviour

1. **Line 1: the name, then a time.** The right-hand slot is always a time (how long it has been in its state while its
   agent works or asks; else when it was last used), or `archiving…` / `restoring…`. Never a badge.
2. **A branch's type prefix is dimmed.** In a branch shown as the name (not a name you gave), the part up to and
   including the first `/` (`feat/`, `fix/`, `docs/`) is drawn muted, so the eye starts at the slug. When the row is
   narrow the name is cut at its end, as today.
3. **Line 2: the project, then one status.** Left: the project (and `· branch` when you named the session), cut with an
   ellipsis. Right, in this order of preference, exactly one text: `snoozed` (as today, a snoozed session stays quiet; what it
   owes is in the hover), else what you owe (`review +2`, `merge`, `CI`, in today's badge colours), else `in review`. After it: `keep` when it is kept, then the PR marks.
4. **A PR is one mark.** Each PR is a small dot in its stage's colour (the pill's tone today), not its number. Hovering
   says `repo #number · stage`; a click opens it, as the pill does. At most five dots, then `+N`. The project is never
   pushed out: the marks have a fixed place at the right.
5. **Older sessions are a heading.** In place of the "+N older" link: a folded heading `Older` with its count, at the
   bottom, that unfolds like any other heading (remembered in this browser). "Hide older" goes away.
6. **No search box.** The rail's header keeps the status legend (`?`) and New worktree (`+`). `/` opens the Ctrl+P
   switcher (same rules as today: not while typing in a field or a terminal, not over a dialog or menu). The shortcuts
   list says so.
7. Unchanged: the order, pins, sections, colours, drag, Alt+1…9, F2, the row's menu and its tooltip (which gains the PR
   numbers, since the row no longer shows them).

## Change manifest

| File | Action | Purpose |
|---|---|---|
| `src/web/src/state/rail-row.ts` | create | Pure: what a row shows (name parts, time, status text, PR marks) |
| `src/web/src/components/Dashboard/SessionRail.tsx` | modify | Draw the row from it; remove the search; Older as a heading; `/` |
| `src/web/src/components/Dashboard/SessionBits.tsx` | modify | `RailPrMarks` in place of `RailPrPills` in the rail |
| `src/web/src/components/Dashboard/QuickSwitcher.tsx` | modify | Open on `/` too |
| `src/web/src/state/session-display.ts` | modify | `railGroups` returns the older sessions as a group |
| `src/web/src/state/shortcuts.ts` | modify | `/` opens the switcher |
| `src/web/src/styles/pages/rail.css` | modify | The row, the marks, no search box |
| `.claude/references/work/session-navigation.md` | modify | The rail as it is now |

## Test manifest

| File | Covers |
|---|---|
| `tests/web/rail-row.test.ts` (new) | Name parts, the time slot per state, which status text wins, PR marks and the `+N` |
| `tests/web/session-rail-search.test.ts` | Search tests removed with the box; `/` opens the switcher; PR marks on a row |
| `tests/web/session-rail-groups.test.ts` | Older as a folded heading with its count |
| `tests/web/session-display.test.ts`, `tests/web/pr-pills.test.ts`, `e2e/demo.spec.ts` | Updated where they looked for the pills, the link or the box |

## Success criteria

- SC1: every row has the same four places: name, time, project, status with marks (tests on `rail-row.ts` and the rendered row).
- SC2: a session with five PRs still shows its project (test: the project element is rendered; the marks are capped).
- SC3: the rail has no search field, and `/` opens the switcher (tests).
- SC4: older sessions sit under an `Older` heading with a count, folded at first (tests).
- SC5: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- SC6: the rail looks right in the running app, light and dark (manual).

## Out of scope

- The Mine · State · Project switch, the State view, the Project view and its hover card (next PRs).
- The Sessions table, the Inbox and Ctrl+P rows: they keep the numbered pills.
- New status icons: each state already has its own shape (`StatusIcon.tsx`).

## Assumptions

- [ASSUMED] Removing `/` as "filter this list" is fine because Ctrl+P already finds any session by the same words.
- [ASSUMED] `Older` starts folded for everyone, including whoever had clicked "+N older" before (that was never remembered).

## Risks

- Tests and the e2e demo find PRs by the pill's class in the rail: updated in this change.
- The PR number is no longer readable at a glance in the rail; it is in the hover text and on the session's page.
