# Adversarial Review — MTK setup-bootstrap artifacts for `cli-work-tree-manager`

> Reviewer: fresh, anti-anchored. Did NOT read `run-report.md`. All claims fact-checked against code only.
> Target branch: `feat/mtk-setup-v7.10.0`. Audited SHA in artifacts: `18e127d` (verified = direct parent of the MTK setup commit `0d2425e`).
> Method: extracted every concrete checkable claim from `CLAUDE.md`, `architecture-principles.md`, `conventions.md`, `.claude/rules/*.md`, and `pre-commit-review-list.md`; verified each with grep/read/glob.

## Findings

| # | artifact:line | claim (quoted) | ground-truth (with evidence) | category | severity |
|---|---|---|---|---|---|
| 1 | CLAUDE.md:41 / architecture.md §2.5 / conventions.md:19 | "136 `.js` imports, 0 extensionless" | TRUE. `grep -rhoE "from ['\"]\.[^'\"]+['\"]" src \| grep -c "\.js['\"]"` → 136; extensionless count → 0. | (verified) | — |
| 2 | CLAUDE.md:43 / architecture.md §2.3 / arch-principles §3.2 | "React/Ink is the terminal renderer ONLY … imports appear only under `src/tui-ink/*.tsx` (5 files)" | TRUE. `grep -rln "from 'react'\|from 'ink'" src` → exactly the 5 `.tsx` files in `src/tui-ink/`. No web/DOM target; `tsconfig.json:15` `"jsx": "react-jsx"`. React is correctly framed as the Ink renderer, NOT a web framework. | (verified) | — |
| 3 | arch-principles §3.3 / architecture.md §2.4 | "`node-pty` … imported in exactly one place … `src/tui/session.ts`" | TRUE. `grep -rln "from 'node-pty'" src` → only `src/tui/session.ts`; `session.ts:68` `pty.spawn(...)`. | (verified) | — |
| 4 | CLAUDE.md:44 / security.md §1.1 / §0.4 | "use `cross-spawn` with an argv array — DO NOT interpolate … into a shell string" | DIRECTIONALLY TRUE but framing is narrow. The codebase uses BOTH `cross-spawn` (`git.ts:1`, `diff-pipeline.ts`, `setup-completions.ts`, `claude-md.ts`, `platform.ts`) AND `node:child_process` `execFile`/`spawn` with argv arrays (`git.ts:2`, `jira.ts:1`, `pr.ts:1`, `diff.ts:4`, `App.tsx:6`). The real invariant — argv arrays, no shell-string interpolation, no `shell:true` (verified: 0 `shell:true` in spawn calls) — is captured in the rule body, but "use cross-spawn" understates the equally-dominant `execFile` pattern. An implementer told "use cross-spawn" might wrongly avoid the established `execFile` path. | WEAK_CLAIM | LOW |
| 5 | security.md §1.3 | "local diff/comment server … Keep it bound to localhost … do not expose it on `0.0.0.0`" | TRUE and load-bearing. `src/core/comment-server.ts:221` `server.listen(0, '127.0.0.1', …)`. The "no-0.0.0.0" security claim matches reality. | (verified) | — |
| 6 | arch-principles §5 / §10 / data-layer.md §5.3 | "`config.json` written with a bare `fs.writeFileSync` (`src/core/config.ts:71`)" vs history/tasks atomic+lock | TRUE, exact line. `config.ts:71` `fs.writeFileSync(configPath, …)`; `history.ts:68` + `tasks.ts:42` use `atomicWriteFile`; `fs-safe.ts:35` `retries:20`, `:36` `stale:10_000`. Correctly tagged `[AMBIGUOUS]`/`[ASPIRATIONAL]`. | (verified) | — |
| 7 | arch-principles §2 / §9.1 | "`wd` is the diff binary / diff viewer" | TRUE. `src/wd-bin.ts` → `run(['diff', ...process.argv.slice(2)])`; `package.json` bin maps `wd → ./dist/wd-bin.js`. | (verified) | — |
| 8 | arch-principles §1/§2 counts | "51 source files", "commands 14", "core 22", "9 test files", "14/14 CommandModule" | ALL TRUE. `find src -name '*.ts' -o -name '*.tsx'` → 51; `ls src/commands/*.ts` → 14; `ls src/core/*.ts` → 22; `find tests -name '*.test.ts'` → 9; `grep -rl CommandModule src/commands` → 14. | (verified) | — |
| 9 | arch-principles §4 (INFERRED:0.8) | "no external HTTP client library … only HTTP usage is a local `node:http` diff/comment server" | TRUE. `grep -rln "octokit\|axios\|node-fetch" src` → none. `jira.ts`/`pr.ts` shell out to external CLIs (`acli`, `gh`) via `execFile`, not HTTP libs. Confidence tag appropriate. | (verified) | — |
| 10 | conventions.md:11 | "TUI components: PascalCase `*.tsx` under `src/tui-ink/` (`App.tsx`, `Sidebar.tsx`, `StatusBar.tsx`, `TerminalPane.tsx`)" | MOSTLY TRUE but incomplete. Those 4 are PascalCase components; the dir also contains `index.tsx` (lowercase entry) and `renderer-lines.ts` (non-`.tsx` helper). Not wrong — just an under-statement of the folder's contents. | OVERREACH/DILUTION | LOW |
| 11 | CLAUDE.md:31 | "no formatter configured in this repo (no biome/prettier config)" | TRUE. No `.prettierrc*`, `biome.json*`, `.eslintrc*` found. | (verified) | — |
| 12 | arch-principles §6 (INFERRED:0.7) | "No dedicated vitest config file" | TRUE. `find . -maxdepth 2 -name 'vitest.config.*'` → none; `package.json` `"test": "vitest run"`. | (verified) | — |
| 13 | git-workflow.md §8.1/§8.3/§8.4 | branch names `feat/`,`docs/`,`feature/`; imperative subjects, no `type:` prefix; "bump to 1.3.0" | TRUE for audited history. Branches `feat/copy-dot-files`, `docs/readme-and-github-pages`, `feature/resume-expanded` exist; commits `Add interactive review mode`, `…bump to 1.3.0` match. (The only conventional-prefix commit `feat: add MTK…` is the setup commit itself, post-dating the audited SHA — so the historical claim holds.) | (verified) | — |
| 14 | §9.3 / tsup | "Runtime deps externalized in `tsup.config.ts`" | TRUE. `tsup.config.ts` `external:[chalk, cross-spawn, …, ink, react, node-pty, @xterm/headless]`, `format:['esm']`, `target:'node18'`, entry both bins. | (verified) | — |
| 15 | CLAUDE.md:74-78 refs | references `architecture-principles.md`, `conventions.md`, `typescript/framework-patterns.md`, `typescript/testing-supplement.md`, `security-checklist.md`, `orchestration-gates.md` | ALL EXIST on disk under `.claude/references/`. No dangling reference. | (verified) | — |
| 16 | §0.5 / §9.2 / pre-commit | "PowerShell port (`work.ps1`) is a SEPARATE implementation" | TRUE. `work.ps1` (54KB) + `work-completions.ps1` at repo root; not generated from TS. | (verified) | — |

## Summary

- **Total concrete claims checked:** ~40 (consolidated into 16 rows above).
- **By category:** FACTUAL_ERROR 0 · HALLUCINATION 0 · MISSING 0 · WEAK_CLAIM 1 (#4) · OVERREACH/DILUTION 1 (#10) · verified-accurate 14.
- **By severity:** BLOCKING 0 · MEDIUM 0 · LOW 2.

### The single most dangerous finding
Finding #4 (LOW): the headline security rule says "use `cross-spawn`," but the repo's equally-dominant subprocess pattern is `node:child_process.execFile` with argv arrays. The underlying safety invariant (argv arrays, no shell interpolation, no `shell:true`) is real and correctly stated in the rule body — so this would not lead to *unsafe* code, only to mild confusion about which API to reach for. Not blocking.

### Specifically checked per the PR's risk callouts
- **React mis-framed as web framework?** NO — every artifact correctly scopes React/Ink to the terminal renderer under `src/tui-ink/` (findings #2). Correct.
- **process-wrapper / no-`shell:true` security claim?** VERIFIED — 0 `shell:true` in spawn calls; comment-server binds `127.0.0.1` not `0.0.0.0` (#5). The only nuance is the cross-spawn-vs-execFile framing (#4).
- **Claimed files exist?** YES — every named file, directory, dependency, line number, count, and confidence tag spot-checked resolved to real code (#1,#3,#6,#7,#8,#15). Audited SHA is genuine and correctly positioned.

## Verdict

**PASS — no BLOCKING findings.** The generated artifacts are unusually accurate: file paths, line numbers, dependency lists, counts (51/14/22/9), the ESM `.js`-import invariant, the React/Ink-renderer-only boundary, the node-pty single-importer rule, the `127.0.0.1` server binding, and the `config.json` bare-write inconsistency all match the code exactly, with appropriate `[EXTRACTED]`/`[INFERRED]`/`[AMBIGUOUS]` confidence tags. The two LOW findings are framing/completeness nits, not errors, and would not mislead an implementer into incorrect or unsafe code. Safe to proceed to PR.
