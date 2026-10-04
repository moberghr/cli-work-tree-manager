import type { GroupRow, RepoRow, ReposWire } from '../../core/api-types.js';
import { enrollProblem, groupProblem, suggestAlias } from '../../core/worktree/repo-rules.js';

/** A refusal, as the real routes answer it (409 when live sessions could be forced past). */
export class DemoRepoError extends Error {
  constructor(
    message: string,
    readonly sessions: string[] = [],
  ) {
    super(message);
  }
}

interface Found {
  path: string;
  folder: string;
  origin: string | null;
}

/**
 * The Repos page in demo mode: a pretend `~/repos` with the demo's projects
 * enrolled and a few clones next to them, changed in memory by the same
 * rules as the real thing (repo-rules.ts).
 */
export function createDemoRepos(liveTargets: () => string[]) {
  const root = '~/repos';
  const repos: Record<string, string> = {
    api: `${root}/api`,
    web: `${root}/web`,
    backend: `${root}/shop-backend`,
    frontend: `${root}/shop-frontend`,
  };
  const groups: Record<string, string[]> = { shop: ['backend', 'frontend'] };
  const ignored = new Set<string>();
  const found: Found[] = [
    { path: `${root}/api`, folder: 'api', origin: 'example/api' },
    { path: `${root}/web`, folder: 'web', origin: 'example/web' },
    { path: `${root}/shop-backend`, folder: 'shop-backend', origin: 'example/shop-backend' },
    { path: `${root}/shop-frontend`, folder: 'shop-frontend', origin: 'example/shop-frontend' },
    { path: `${root}/billing`, folder: 'billing', origin: 'example/billing' },
    { path: `${root}/hangfire`, folder: 'hangfire', origin: 'HangfireIO/Hangfire' },
    { path: `${root}/wolverine`, folder: 'wolverine', origin: 'JasperFx/wolverine' },
  ];
  const sessionsOn = (target: string) => liveTargets().filter((t) => t === target).length;
  const config = () => ({ repos, groups });

  return {
    /** GET /api/projects: what New worktree offers, as the real one reads config. */
    projects() {
      return {
        singles: Object.entries(repos).map(([name, path]) => ({ name, kind: 'single' as const, path })),
        groups: Object.entries(groups).map(([name, members]) => ({ name, kind: 'group' as const, members })),
      };
    },
    inventory(): ReposWire {
      const enrolledAt = new Set(Object.values(repos));
      const rows: RepoRow[] = Object.entries(repos).map(([alias, p]) => ({
        path: p,
        folder: p.split('/').pop()!,
        origin: found.find((f) => f.path === p)?.origin ?? null,
        status: 'enrolled',
        alias,
        groups: Object.entries(groups).flatMap(([g, m]) => (m.includes(alias) ? [g] : [])),
        sessions: sessionsOn(alias),
      }));
      for (const f of found) {
        if (enrolledAt.has(f.path)) continue;
        if (ignored.has(f.path)) {
          rows.push({ ...f, status: 'ignored', alias: null, groups: [], sessions: 0 });
          continue;
        }
        const suggested = suggestAlias(f.path, (a) => a in repos || a in groups);
        rows.push({
          ...f,
          status: 'new',
          alias: null,
          suggestedAlias: suggested,
          problem: enrollProblem(suggested, f.path, config()),
          groups: [],
          sessions: 0,
        });
      }
      rows.sort((a, b) => a.folder.localeCompare(b.folder));
      const groupRows: GroupRow[] = Object.entries(groups).map(([name, members]) => ({
        name,
        members,
        missing: members.filter((m) => !(m in repos)),
        sessions: sessionsOn(name),
        problem: new Set(members).size < 2 ? 'a group needs at least two repos' : null,
      }));
      return { roots: [root], repos: rows, groups: groupRows };
    },
    enroll(alias: string, path: string) {
      if (!found.some((f) => f.path === path)) throw new DemoRepoError(`${path} is not the top folder of a git repository`);
      const problem = enrollProblem(alias, path, config());
      if (problem) throw new DemoRepoError(problem);
      repos[alias] = path;
      ignored.delete(path);
    },
    remove(alias: string, force: boolean) {
      if (!(alias in repos)) throw new DemoRepoError(`no repo “${alias}”`);
      const n = sessionsOn(alias);
      if (n && !force) throw new DemoRepoError(`${n} live session${n === 1 ? '' : 's'} on ${alias}`, [`${alias} · …`]);
      delete repos[alias];
      for (const g of Object.keys(groups)) groups[g] = groups[g].filter((m) => m !== alias);
    },
    ignore(path: string, on: boolean) {
      if (on) ignored.add(path);
      else ignored.delete(path);
    },
    saveGroup(name: string, members: string[], creating: boolean) {
      const problem = groupProblem(name, members, config(), { creating });
      if (problem) throw new DemoRepoError(problem);
      groups[name] = [...new Set(members)];
    },
    deleteGroup(name: string, force: boolean) {
      if (!(name in groups)) throw new DemoRepoError(`no group “${name}”`);
      const n = sessionsOn(name);
      if (n && !force) throw new DemoRepoError(`${n} live session${n === 1 ? '' : 's'} on ${name}`, [`${name} · …`]);
      delete groups[name];
    },
  };
}
