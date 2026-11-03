import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_INSTRUCTIONS } from '../../src/core/agents/assistant.js';
import { DEFAULT_PROMPTS } from '../../src/core/sessions/saved-prompts.js';
import { importsOf, lineOf, resolveLocal, ROOT, scanFile, sourceFiles } from './source-scan.js';

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

const HOSTS_DIR = 'src/core/hosts/';
/** Every host's own folder: any folder under core/hosts/ with an adapter.ts (a new host is guarded the day it lands). */
const hostDirs = () =>
  fs
    .readdirSync(path.join(ROOT, HOSTS_DIR), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, HOSTS_DIR, e.name, 'adapter.ts')))
    .map((e) => `${HOSTS_DIR}${e.name}/`);
/**
 * The registry's modules, the only importers of the hosts' own folders: index.ts (the adapters), and the pure
 * tables the SPA and the demo share (commands.ts: each host's commands; links.ts: each host's PR links).
 */
const REGISTRY = ['src/core/hosts/index.ts', 'src/core/hosts/commands.ts', 'src/core/hosts/links.ts'];
/**
 * The exceptions, each with its reason:
 * - work's own updates: work itself is published on GitHub, whatever host a project is on;
 * - the demo: a made-up world whose repos are on GitHub and Azure DevOps (its data, not a dependency on them).
 */
const EXCEPT = ['src/core/updates/', 'src/server/demo/'];

/** `gh` as a command: a string that is `gh` or `gh.exe`, maybe as a path (`/usr/bin/gh`, `C:\…\gh.exe`), or starts a command line with it. */
export const GH_COMMAND = /^(?:.*[\\/])?gh(?:\.exe)?(\s|$)/i;
/** github.com, as written in a string or a regex (`github.com`, `github\.com`, and `github\\.com` in a string passed to RegExp). */
export const GITHUB_URL = /github(\\{1,2})?\.com/i;
/** `az` (the Azure CLI) as a command, the same way. */
export const AZ_COMMAND = /^(?:.*[\\/])?az(?:\.cmd|\.exe)?(\s|$)/i;
/** Azure DevOps' addresses, as written in a string or a regex. */
export const AZURE_URL = /dev(\\{1,2})?\.azure(\\{1,2})?\.com|visualstudio(\\{1,2})?\.com/i;

/** What is each host's alone — its CLI and its addresses — by its folder's name: only its own folder may use them. */
const OWN: Record<string, { what: string; cli: RegExp; url: RegExp }> = {
  github: { what: 'runs gh or names github.com', cli: GH_COMMAND, url: GITHUB_URL },
  azure: { what: 'runs az or names Azure DevOps', cli: AZ_COMMAND, url: AZURE_URL },
};

/**
 * Where a text runs a host's CLI or names its address, as `line: what` (comments don't count: they may say what
 * the host does). GitHub's by default. `file`: a .tsx file's JSX is read as JSX.
 */
export function hostLeaks(text: string, own: { cli: RegExp; url: RegExp } = OWN.github, file = 'x.ts'): string[] {
  const s = scanFile(file, text);
  const out: string[] = [];
  for (const lit of s.strings) if (own.cli.test(lit.value)) out.push(`${lit.line}: '${lit.value.slice(0, 60)}'`);
  for (const m of s.code.matchAll(new RegExp(own.url.source, 'gi')))
    out.push(`${lineOf(text, m.index)}: ${text.split('\n')[lineOf(text, m.index) - 1].trim().slice(0, 100)}`);
  return out;
}

describe('git hosts', () => {
  it('every host folder has its own words listed (a new host is guarded, not skipped)', () => {
    const dirs = hostDirs();
    expect(dirs).toEqual(expect.arrayContaining(['src/core/hosts/github/', 'src/core/hosts/azure/']));
    for (const d of dirs) expect(Object.keys(OWN), d).toContain(d.slice(HOSTS_DIR.length, -1));
  });

  for (const [id, own] of Object.entries(OWN))
    it(`nothing outside ${id}'s own folder ${own.what} (the rest of core/hosts/ and the other hosts included)`, () => {
      const offenders = sourceFiles('src')
        .filter((f) => !f.startsWith(`${HOSTS_DIR}${id}/`) && !EXCEPT.some((e) => f.startsWith(e)))
        .flatMap((f) => hostLeaks(fs.readFileSync(path.join(ROOT, f), 'utf8'), own, f).map((l) => `${f}:${l}`));
      expect(offenders).toEqual([]);
    });

  it("nothing outside the registry imports a host's own folder — statically or lazily", () => {
    const dirs = hostDirs();
    const offenders: string[] = [];
    for (const f of sourceFiles('src')) {
      if (REGISTRY.includes(f) || dirs.some((d) => f.startsWith(d))) continue;
      const { runtime, types } = importsOf(fs.readFileSync(path.join(ROOT, f), 'utf8'), { jsx: f.endsWith('.tsx') });
      for (const spec of [...runtime, ...types].filter((s) => s.startsWith('.'))) {
        const target = resolveLocal(f, spec);
        if (target && dirs.some((d) => target.startsWith(d))) offenders.push(`${f} → ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a host's folder doesn't import another host's: each adapter stands alone", () => {
    const dirs = hostDirs();
    const offenders: string[] = [];
    for (const d of dirs)
      for (const f of sourceFiles(d.slice(0, -1))) {
        const { runtime, types } = importsOf(fs.readFileSync(path.join(ROOT, f), 'utf8'));
        for (const spec of [...runtime, ...types].filter((s) => s.startsWith('.'))) {
          const target = resolveLocal(f, spec);
          if (target && dirs.some((o) => o !== d && target.startsWith(o))) offenders.push(`${f} → ${target}`);
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

describe('the guard sees what the re-review found it missed (#63 re-review N008, N009)', () => {
  it('github.com escaped for a RegExp string, gh.exe, and gh by its path', () => {
    // The source text `new RegExp('^https://github\\.com/')`: two backslashes as written.
    expect(hostLeaks("const re = new RegExp('^https://github\\\\.com/');")).toHaveLength(1);
    expect(hostLeaks("spawn('gh.exe', args)")).toEqual(["1: 'gh.exe'"]);
    expect(hostLeaks("spawn('/usr/bin/gh', args)")).toEqual(["1: '/usr/bin/gh'"]);
    expect(hostLeaks("spawn('C:\\\\Program Files\\\\GitHub CLI\\\\gh.exe', args)")).toHaveLength(1);
    expect(hostLeaks("const b = 'refs/heads/gh-pages'; const c = 'sigh';")).toEqual([]);
  });

  it('in a .tsx file: a github.com URL in JSX text, and a gh call after an apostrophe in JSX text', () => {
    expect(hostLeaks('const a = <p>See https://github.com/acme/api</p>;', undefined, 'x.tsx')).toHaveLength(1);
    expect(hostLeaks("const b = <p>Don't</p>; run('gh', []);", undefined, 'x.tsx')).toEqual(["1: 'gh'"]);
  });

  it("Azure DevOps' words: az as a command, its addresses", () => {
    const azure = { cli: AZ_COMMAND, url: AZURE_URL };
    expect(hostLeaks("run('az', ['repos', 'pr', 'list'])", azure)).toEqual(["1: 'az'"]);
    expect(hostLeaks("run('az.cmd', [])", azure)).toEqual(["1: 'az.cmd'"]);
    expect(hostLeaks("const u = 'https://dev.azure.com/org';", azure)).toHaveLength(1);
    expect(hostLeaks('const r = /visualstudio\\.com/;', azure)).toHaveLength(1);
    expect(hostLeaks("const s = 'azure'; const t = 'lazy';", azure)).toEqual([]);
  });
});
