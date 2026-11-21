# Issues (`#/issues`, `core/issues/`)

**Why.** The page was "Jira" and everything about an issue talked to Jira directly. Issues can come from elsewhere (GitHub Issues #86, Azure DevOps work items #87), so the page is **Issues** and Jira is one connector behind a contract (#85). The Jira watch itself is in `jira-watch.md`.

**The tab** is `issues` (`DashboardTab`; `g j` still opens it; the old `#/jira` link lands on it, `OLD_TAB`). It is still `JiraTab.tsx` — Jira is the only source — and says where its list is from ("… assigned to you · from Jira"). The Settings section is **Issues** (the rules below, the watch's daily cap, the Jira worklog settings). Its header is a `PageHeader` and its buttons and picks are the shared pieces (`web-ui.md`); its rows are Start's (`styles/pages/start.css`), the watch's own rules are in `styles/pages/issues.css`.

**Which project an issue starts in** (asked for: a Jira project can be on several boards and span repos, and a GitHub issue's repo can be part of a group, so neither "its board" nor "its repo" is the answer by itself). You say it once, in Settings → Issues → **Issues start in** (`issues.rules`, a list), a rule a line:

```
<source>:<scope>[/<facet>] -> <project>

jira:PAY -> api                 every issue of the Jira project PAY
jira:SHOP/checkout -> shop      issues of SHOP with the component or label "checkout" (a group)
github:acme/web -> shop         issues of that GitHub repo start in the group
azure:Payments/Core\API -> api  an Azure DevOps project, under that area path
```

`core/issues/issue-place.ts` (pure): `parseIssueRule` (a GitHub scope is `owner/repo` whole; elsewhere what follows the first slash narrows the scope), `issueRules` (the setting's lines; what isn't a rule, with why), `placeIssue(issue, rules, projects)`. An issue is seen as `{source, scope, facets?}` whatever connector it came from. Among the rules about its source and scope, ones whose facet the issue has win over ones with none. One project named: there. § Several named, or one that isn't one of your repos or groups: NOT placed, with why — never a pick between them. With `facets` unknown (a list of issues doesn't carry components), a scope is placed only when every rule about it names the same project.

Not by board: a board is a saved view over projects, and a project can be on several.

**Where the rules are used** (`core/issues/jira-placed.ts`: `jiraPlaced` — the project key is the scope, components and labels the facets — and `placeJira`):
- **The watch** (`WatchDeps.place`, `jira-watch.ts`). § It starts an issue by itself ONLY where a rule of yours says `(auto)` after its project (`jira:PAY -> api (auto)`; asked for: nothing starts unless you set it). Then it starts there, the rule as the decision's reason, the model not asked. A rule without it (or with `(ask)`) only says where: a suggestion in that project. Rules that don't settle it: a suggestion with why. No rule about it: the model is still asked (with where earlier issues of the project went), but its answer — however sure — is a suggestion with its project, never a start. Rules for one project that disagree on `(auto)`: the careful one holds.
- **Start on the tab**: the list marks each issue your rules place (`Issue.startsIn`, by its scope alone: `listIssues`); the button says "Start in api" and New worktree opens with that project filled in, to change.

The Settings page takes exactly the lines the parser reads (`SETTING_PATTERNS.issueRule`; a test holds the two together).

**The contract** (`core/issues/issue-source.ts`): a connector per system, the way git hosts sit behind one. `IssueSource`: `mine()` (your open issues; `available: false` when it can't reach its system — said on the tab, never shown as none), `mineOrThrow()` (all of them, or it throws: for a reader that must tell none from couldn't-ask), `detail(key)` (scope, facets, text), `scopeOf(key)` (a scope the key itself says: `PAY-12` → `PAY`), `isKey`, `branchFor`, `prompt`. A `Issue` is a row (`source`, `key`, `summary`, `status`, `statusCategory`, `issuetype`, `priority`, `url`, `startsIn`): Jira's issue fields with where it is from, so the tab and the watch's rows needed no second shape. `listIssues(sources, config)` is every connector's issues in one list, each marked with the project your rules start it in; a connector that fails is said and the others still listed. `placeBySource` is the rules for any connector (`placeJira` is it for Jira).

**Jira is the first connector** (`core/issues/jira-source.ts`: `jiraSource()`, over `core/jira`; `issueSources()` is the list of connectors). § A new connector is added to `issueSources()` AND to `ISSUE_SOURCES` (issue-place.ts), so a rule can name it; a test holds the two together.

**A session's issue** is two fields: `issueKey` (the key as its system shows it: `PAY-12`, `acme/web#12`) and `issueSource` (which connector it is a key of; absent: Jira's). Read them with `sessionIssue(s)` → `{source, key}`; it is on the wire as `SessionWire.issue` beside `issueKey`. **work's own key** for an issue is one text, the same for every connector: `issueId(ref)` = `jira:PAY-12`, `github:acme/web#12` — what a flag or a stored id carries when the system must go with the key. `work tree --issue-key` takes either form: `splitIssueId` (no connector needed: the session store uses it) records the system when the text names one, and `parseIssue(text, sources)` reads a bare key as the connector's that knows its shape. There is no `jiraKey` and no `--jira-key` any more. § A row or an archive written before the rename still says `jiraKey`: `history.ts` reads it as that issue's key, Jira's (`upgraded`), with no migration of the table — an older work still reads its own field — and the row is written in today's shape the next time it is saved.

**API.** `GET /api/issues` → `IssuesWire` (`{sources: [{id, name, available, error?}], issues}`); the watch under `/api/issues/watch…`. The page's old routes (`/api/jira`, `/api/jira/watch…`) answer as before, for an app from before the rename: one handler under both names (`app.on(method, [paths])`), and the demo answers both.

**Not yet**: the watch still sweeps Jira alone (it goes over every connector when a second exists). The other connectors: #86, #87. Posting hours as Jira worklogs (the Time tab) stays Jira's own, and reads a session's key as a Jira key.
