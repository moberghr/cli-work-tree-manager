# Session rail: the State view and the view switch

Date: 2026-11-25 · Scope: UI change · Branch: `feat/session-rail-state` (on top of `feat/session-rail-views`, PR #95) ·
PR 3 of the rail redesign

## Problem

The rail has one order: yours (pins, sections, drag). It answers "where did I put it", not "what needs me now". The two
sessions that owe you a review look the same as the idle ones around them, wherever they happen to sit.

## Behaviour

1. **A switch in the rail's header: Mine · State.** Left of the status legend (`?`) and New worktree (`+`). The shared
   `Segmented` control, as tabs. The choice is remembered in this browser (`work-web:rail-view`); `Mine` at first.
   Project joins it in the next PR.
2. **Mine** is the rail as it is after PR #95. Nothing in it changes.
3. **State** groups the same rows (same row shape) under these headings, in this order, each with its count:
   - **Needs you**: not snoozed, and its agent asks for input or you owe it something (the owed badge: a turn to
     review, replies, merge, CI).
   - **Working**: not in the group above, and working, in background, active, archiving or restoring.
   - **Idle**: every other current session.
   - **Snoozed**: snoozed sessions, whatever else is true of them.
   - **Older**: as in Mine (not entered in 14 days and not running), folded at first. An older session that needs
     you is under Needs you, not here.
   A heading with no sessions is not shown.
4. **Order inside a State group** is Mine's order (your drag order, unplaced first), so a row keeps its place among its
   neighbours and only moves when its state changes. Pins and sections do not group anything here; a row's colour bar
   is still drawn.
5. **State is read-only for placement.** No drag, no Alt+↑/↓, no section headings or their menu. A row's right-click
   menu is unchanged (Pin, Move to, Color still work: they change Mine).
6. **Folding** works as in Mine and is remembered per heading, separately from Mine's headings (Older's is the one
   fold both views share). The selected session's
   row stays visible in a folded group, as in Mine.
7. **Keyboard**: Alt+1…9 and j/k follow the rows as shown in the view that is on. F2, `/`, Ctrl+P unchanged.
8. A session that changes state moves to its new group at once; nothing animates.

## Change manifest

| File | Action | Purpose |
|---|---|---|
| `src/web/src/state/rail-views.ts` | create | Pure: the views, which State group a session is in, the groups of a view, the stored choice |
| `src/web/src/components/Dashboard/SessionRail.tsx` | modify | The switch; draw the view's groups; placement off outside Mine |
| `src/web/src/apps/DashboardApp.tsx` | modify | j/k's fallback order follows the view |
| `src/web/src/styles/pages/rail.css` | modify | The header with the switch |
| `.claude/references/work/session-navigation.md` | modify | The views |

## Test manifest

| File | Covers |
|---|---|
| `tests/web/rail-views.test.ts` (new) | Each session kind's group, snoozed and owed together, the order inside a group, empty groups left out, Older, the stored choice (a bad stored value is Mine) |
| `tests/web/session-rail-views.test.ts` (new) | The switch renders and is remembered; State shows headings with counts; no drag in State; fold remembered apart from Mine's; Alt+1…9 follows State's rows |

## Success criteria

- SC1: every session appears exactly once in State, in the group Behaviour 3 names (tests).
- SC2: switching views changes only the grouping: the same rows, the same row markup (tests).
- SC3: in State nothing can be dragged and no placement is written (tests).
- SC4: the choice survives a reload (test on the stored value).
- SC5: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- SC6: it looks right in the demo, dark and light, with the switch's labels whole at the rail's narrowest width: the `?` and `+` buttons go to a
  second row there (manual).

## Out of scope

- The Project view and its hover card (next PR).
- Sorting inside a group by anything other than Mine's order.
- Remembering the view on the server (it is per browser, like the fold state).

## Assumptions

- [ASSUMED] "in review" (its PR waits on others) is not a group of its own: such a session is Idle, and line 2 says
  `in review`.
- [ASSUMED] A snoozed session that owes you something belongs under Snoozed, as its row says `snoozed`.

## Risks

- The header gets tighter: switch, `?`, `+` in a rail that can be narrow. The switch's labels are short; checked at the
  narrowest width.
- Rows jump between groups while agents work. That is the point of the view; Mine stays still.
