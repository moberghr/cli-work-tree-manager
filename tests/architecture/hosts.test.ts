import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_INSTRUCTIONS } from '../../src/core/agents/assistant.js';
import { DEFAULT_PROMPTS } from '../../src/core/sessions/saved-prompts.js';
import { importsOf, lineOf, resolveLocal, ROOT, scan, sourceFiles } from './source-scan.js';

/**
 * work talks to git hosts through the GitHost adapter (core/hosts/types.ts):
 * what is GitHub's — its CLI, its URLs, its API — lives in
 * src/core/hosts/github/, resolved per repo from its origin (hosts/index.ts).
 * Anything else that ran `gh` or read a github.com URL would be a feature a
 * repo on another host doesn't get (#63).
 *
 * Whole files are read (source-scan.ts): a `gh` call Prettier wrapped over
 * several lines, or a regex written `github\.com`, is still seen.
 */

const GITHUB_DIR = 'src/core/hosts/github/';
/** The registry: the only importer of the hosts' own folders (index.ts, and the pure tables the SPA shares). */
const REGISTRY_DIR = 'src/core/hosts/';
const HOST_DIRS = ['src/core/hosts/github/', 'src/core/hosts/azure/'];
/**
 * The exceptions, each with its reason:
 * - work's own updates: work itself is published on GitHub, whatever host a project is on;
 * - the demo: a made-up world whose repos are on GitHub (its data, not a dependency on it).
 */
const EXCEPT = ['src/core/updates/', 'src/server/demo/'];

/** `gh` as a command: a string that is `gh`, or starts with `gh ` (a command line). */
export const GH_COMMAND = /^gh(\s|$)/;
/** github.com, as written in a string or a regex (`github.com`, `github\.com`). */
export const GITHUB_URL = /github(\\)?\.com/i;

/** Where a text runs `gh` or names github.com, as `line: what` (comments don't count: they may say what GitHub does). */
export function hostLeaks(text: string): string[] {
  const s = scan(text);
  const out: string[] = [];
  for (const lit of s.strings) if (GH_COMMAND.test(lit.value)) out.push(`${lit.line}: '${lit.value.slice(0, 60)}'`);
  for (const m of s.code.matchAll(new RegExp(GITHUB_URL.source, 'gi')))
    out.push(`${lineOf(text, m.index)}: ${text.split('\n')[lineOf(text, m.index) - 1].trim().slice(0, 100)}`);
  return out;
}

const scanned = () => sourceFiles('src').filter((f) => !f.startsWith(GITHUB_DIR) && !EXCEPT.some((e) => f.startsWith(e)));

describe('git hosts', () => {
  it("nothing outside GitHub's adapter runs gh or reads or writes a github.com URL", () => {
    const offenders = scanned().flatMap((f) => hostLeaks(fs.readFileSync(path.join(ROOT, f), 'utf8')).map((l) => `${f}:${l}`));
    expect(offenders).toEqual([]);
  });

  it("nothing outside the registry imports a host's own folder (core/hosts/github/, core/hosts/azure/)", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles('src')) {
      if (f.startsWith(REGISTRY_DIR)) continue;
      const { runtime, types } = importsOf(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      for (const spec of [...runtime, ...types].filter((s) => s.startsWith('.'))) {
        const target = resolveLocal(f, spec);
        if (target && HOST_DIRS.some((d) => target.startsWith(d))) offenders.push(`${f} → ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('what every session is told by default names no host: the assistant, the saved prompts, the skills', () => {
    const skillsDir = path.join(ROOT, 'plugins/work-tree/skills');
    const skills = fs.readdirSync(skillsDir).map((d) => fs.readFileSync(path.join(skillsDir, d, 'SKILL.md'), 'utf8'));
    expect(skills.length).toBeGreaterThan(0);
    for (const text of [ASSISTANT_INSTRUCTIONS, ...DEFAULT_PROMPTS.map((p) => p.prompt), ...skills]) {
      expect(text).not.toMatch(/GitHub|`gh |\bgh pr\b/);
    }
  });
});

describe('the guard sees what a line-by-line one missed (#63 review F002)', () => {
  it('a gh call Prettier wrapped over several lines, and one in a template', () => {
    // The shape of ship.ts / pr-start.ts / branch-tidy.ts / pr.ts / pr-review.ts / pr-replies.ts before #63.
    const wrapped = ['  const view = await run(', "    'gh',", "    ['pr', 'view', branch, '--json', 'number'],", '    cwd,', '  );'].join(
      '\n',
    );
    expect(hostLeaks(wrapped)).toEqual(["2: 'gh'"]);
    expect(hostLeaks('const r = await execAsync(\n  "gh",\n  args,\n);')).toEqual(["2: 'gh'"]);
    expect(hostLeaks('const cmd = `gh pr checks ${n}`;')).toEqual(["1: 'gh pr checks '"]);
    expect(hostLeaks("spawn('gh', ['api', 'user'])")).toEqual(["1: 'gh'"]);
  });

  it('github.com written as a regex (pr.ts, blocks.ts before #63) or in a string', () => {
    expect(hostLeaks('const m = /^https:\\/\\/github\\.com\\/([^/]+)/.exec(u);')).toHaveLength(1);
    expect(hostLeaks('if (/(^|[@/.])github\\.com[:/]/i.test(origin)) return true;')).toHaveLength(1);
    expect(hostLeaks("const u = 'https://github.com/' + repo;")).toHaveLength(1);
  });

  it("a '/*' inside a string doesn't hide the code after it; comments and other words aren't flagged", () => {
    expect(hostLeaks("const glob = 'src/*';\nrun('gh', []);\nconst x = '*/';")).toEqual(["2: 'gh'"]);
    expect(hostLeaks('// gh pr view runs here\n/* github.com */\nconst ghost = "ghost";\nconst high = a / gh / 2;')).toEqual([]);
    expect(hostLeaks("const s = 'ughh';\nconst t = `ok ${'gh'}`;")).toEqual(["2: 'gh'"]);
  });
});
