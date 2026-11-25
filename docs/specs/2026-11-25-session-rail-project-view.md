# Session rail: the Project view and its hover card

Date: 2026-11-25 · Scope: UI change · Branch: `feat/session-rail-project` (on top of `feat/session-rail-state`, PR #96) ·
PR 4 of the rail redesign

## Problem

Mine and State both spend a row's second line on the project, and neither answers "what is going on in `api`". With
many sessions in few projects the same word is repeated down the rail, and starting another worktree in a project
means opening the dialog and picking the project again.

## Behaviour

1. **The switch gains Project:** Mine · State · Project. Remembered like the others (`work-web:rail-view`).
2. **Project groups the sessions by project**, one heading per project (a repo, or a group: a group session is under
   its group's name, not under its member repos), with its count. Headings are in alphabetical order, whatever the
   case. Then **Older**, as in State: an older session is under Older unless it is the selected one or it needs you.
3. **A heading has a `+`** at its right: New worktree with that project already chosen. Not on Older.
4. **A row is one line here:** the status icon, the name (a branch's `feat/` muted, as elsewhere), then the one
   status (`snoozed`, what you owe, `in review`), the PR dots, and the time. The project is the heading, so the row
   does not repeat it. `keep` and the branch of a session you named are in the card.
5. **Hovering or focusing a row shows a card** beside the rail, in place of the row's plain tooltip: the name, the
   project and branch, its state with the agent's last line, each PR with its title and stage, and the details the
   tooltip has in the other views (snoozed until, notes, kept, account). It comes after a short wait on hover and at
   once on keyboard focus; it goes when the pointer or focus leaves, on Esc, a click, a scroll, a right-click, a
   rename, or when the rows change under it. It is read-only: nothing in it is clicked (a PR opens from its dot, as
   before), and the pointer cannot move onto it.
6. **Order inside a project** is Mine's order. **Placement is Mine's**, as in State: no drag, no Alt+↑/↓, no section
   headings. The row's menu is unchanged.
7. **Folding** is remembered per project heading. Alt+1…9 and j/k follow the rows shown.

## Change manifest

| File | Action | Purpose |
|---|---|---|
| `src/web/src/state/rail-views.ts` | modify | The `project` view and its groups |
| `src/web/src/state/rail-row.ts` | modify | Pure: what the card says |
| `src/web/src/components/Dashboard/SessionRail.tsx` | modify | The one-line row, the heading's `+`, the card |
| `src/web/src/apps/DashboardApp.tsx` | modify | New worktree opens with the heading's project |
| `src/web/src/styles/pages/rail.css` | modify | The one-line row, the `+`, the card |
| `.claude/references/work/session-navigation.md` | modify | The Project view |

## Test manifest

| File | Covers |
|---|---|
| `tests/web/rail-views.test.ts` | Project groups: one per project in alphabetical order, a group session under its group, Mine's order inside, Older and its two exceptions, the switch's three options |
| `tests/web/rail-row.test.ts` | The card: name, where, state, PRs with titles and stages, notes |
| `tests/web/session-rail-views.test.ts` | Project headings with counts; the `+` passes the project; a row is one line with no project text; the card on focus and gone on blur; no drag |

## Success criteria

- SC1: every session appears exactly once in Project, under its project or Older (tests).
- SC2: a heading's `+` opens New worktree with that project (test on the callback; the dialog's prefill is existing).
- SC3: a Project row has one line and no `title` tooltip; its card names every PR with its title when known (tests).
- SC4: nothing can be dragged in Project (test).
- SC5: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- SC6: it looks right in the demo, dark and light; the card stays inside the window near the bottom edge (manual).

## Out of scope

- The card in Mine and State (their rows keep the tooltip).
- Links or buttons inside the card.
- Sorting projects by anything other than name.

## Assumptions

- [ASSUMED] A PR's title comes from the dashboard's PR list; a PR only the PR watch knows is shown without a title.
- [ASSUMED] Older keeps its place at the bottom here too, so a project with only old sessions has no heading.

## Risks

- Three labels make the switch wider: `?` and `+` go to a second row (together) in a rail under about 260 px, which
  includes the default width (248 px). The header is then two rows in every view until the rail is widened.
- A one-line row in a narrow rail leaves little room for the name: the status and time never shrink, the name is cut.
