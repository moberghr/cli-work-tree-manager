import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GroupRow, RepoRow, ReposWire } from '../../../../../core/api-types.js';
import { enrollProblem, groupProblem } from '../../../../../core/worktree/repo-rules.js';
import {
  deleteGroup,
  enrollRepo,
  fetchRepos,
  ignoreRepo,
  removeRepo,
  RepoChangeError,
  saveGroup,
  setScanRoot,
} from '../../../api/panes.js';
import { useSse } from '../../../api/events.js';

type Filter = 'new' | 'enrolled' | 'ignored' | 'all';

/** The calls the page makes (tests swap them). */
export interface ReposApi {
  load: () => Promise<ReposWire>;
  enroll: (alias: string, path: string) => Promise<void>;
  remove: (alias: string, force?: boolean) => Promise<void>;
  ignore: (path: string, ignored: boolean) => Promise<void>;
  scanRoot: (path: string, on: boolean) => Promise<void>;
  saveGroup: (name: string, members: string[], creating: boolean) => Promise<void>;
  deleteGroup: (name: string, force?: boolean) => Promise<void>;
}

const httpRepos: ReposApi = {
  load: fetchRepos,
  enroll: enrollRepo,
  remove: removeRepo,
  ignore: ignoreRepo,
  scanRoot: setScanRoot,
  saveGroup,
  deleteGroup,
};

/** Which rows a filter shows; `missing` counts as enrolled (it is, its folder is gone). Pure. */
export function reposShown(rows: RepoRow[], filter: Filter, query: string): RepoRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (filter === 'new' && r.status !== 'new') return false;
    if (filter === 'enrolled' && r.status !== 'enrolled' && r.status !== 'missing') return false;
    if (filter === 'ignored' && r.status !== 'ignored') return false;
    const hay = `${r.folder} ${r.alias ?? ''} ${r.origin ?? ''} ${r.path}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A refusal that names live sessions can be confirmed and forced. */
interface Pending {
  key: string;
  text: string;
  force: () => Promise<void>;
}

/**
 * The repos work knows, and the ones it could: every git repo in your
 * scanned folders — enrolled, new, ignored — with Add (an alias, checked as
 * you type), Remove, Ignore; and the groups, made from enrolled repos.
 * A group's name is final (its sessions and worktree folders carry it);
 * its repos can change, for new sessions.
 */
export function ReposTab({
  api = httpRepos,
  onBack,
}: {
  api?: ReposApi;
  /** Back to Start (the page it's reached from). */ onBack?: () => void;
}) {
  const [data, setData] = useState<ReposWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [query, setQuery] = useState('');
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [newRoot, setNewRoot] = useState('');

  const load = useCallback(() => {
    api.load().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [api]);
  useEffect(load, [load]);
  useSse('/events', { events: { 'repos-changed': load } });

  const counts = useMemo(() => {
    const c = { new: 0, enrolled: 0, ignored: 0 };
    for (const r of data?.repos ?? []) {
      if (r.status === 'new') c.new++;
      else if (r.status === 'ignored') c.ignored++;
      else c.enrolled++;
    }
    return c;
  }, [data]);
  // Opens on what's left to decide, when there is any.
  const shownFilter: Filter = filter ?? (counts.new > 0 ? 'new' : 'enrolled');
  const rows = useMemo(() => reposShown(data?.repos ?? [], shownFilter, query), [data, shownFilter, query]);
  const config = useMemo(() => {
    const repos: Record<string, string> = {};
    for (const r of data?.repos ?? []) if (r.alias) repos[r.alias] = r.path;
    const groups: Record<string, string[]> = {};
    for (const g of data?.groups ?? []) groups[g.name] = g.members;
    return { repos, groups };
  }, [data]);

  /** Run a change; a refusal naming live sessions is held for "… anyway". */
  const act = (key: string, fn: () => Promise<void>, force?: () => Promise<void>) => {
    setBusy(key);
    setRowError(({ [key]: _, ...rest }) => rest);
    setPending(null);
    fn()
      .then(load, (e: Error) => {
        if (force && e instanceof RepoChangeError && e.sessions.length)
          setPending({ key, text: `${e.message}: ${e.sessions.join(', ')}.`, force });
        else setRowError((m) => ({ ...m, [key]: e.message }));
      })
      .finally(() => setBusy(null));
  };

  if (error) return <div className="wd-tab-empty wd-tab-error">{error}</div>;
  if (!data) return <div className="wd-tab-empty">Scanning…</div>;

  return (
    <div className="wd-dash-tab-pane wd-tab-repos">
      <header className="wd-tab-header">
        <h1>
          {onBack && (
            <button type="button" className="wd-link-button wd-tab-back" onClick={onBack} title="Back to Start">
              ← Start
            </button>
          )}
          Repos{' '}
          <span className="wd-tab-header-muted">
            {counts.enrolled} enrolled · {counts.new} new · {counts.ignored} ignored
          </span>
        </h1>
        <div className="wd-tab-controls">
          <input
            className="wd-tab-search"
            type="search"
            placeholder="Search folder, alias, origin…"
            aria-label="Search repos"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="wd-segmented" role="group" aria-label="Show">
            {(['new', 'enrolled', 'ignored', 'all'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={'wd-segmented-btn' + (shownFilter === f ? ' wd-segmented-btn-on' : '')}
                aria-pressed={shownFilter === f}
                onClick={() => setFilter(f)}
              >
                {f === 'new'
                  ? `New ${counts.new}`
                  : f === 'enrolled'
                    ? `Enrolled ${counts.enrolled}`
                    : f === 'ignored'
                      ? `Ignored ${counts.ignored}`
                      : 'All'}
              </button>
            ))}
          </span>
        </div>
      </header>

      <section className="wd-repos-roots">
        <span className="wd-tab-header-muted">Scanned:</span>
        {data.roots.map((r) => (
          <span key={r} className="wd-repos-root">
            {r}
            <button
              type="button"
              className="wd-link-button"
              aria-label={`Stop scanning ${r}`}
              title="Stop scanning this folder"
              onClick={() => act(`root:${r}`, () => api.scanRoot(r, false))}
            >
              ×
            </button>
          </span>
        ))}
        <form
          className="wd-repos-root-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newRoot.trim()) return;
            act('root:new', () => api.scanRoot(newRoot.trim(), true).then(() => setNewRoot('')));
          }}
        >
          <input
            value={newRoot}
            onChange={(e) => setNewRoot(e.target.value)}
            placeholder="Add a folder to scan"
            aria-label="Folder to scan"
          />
        </form>
        {rowError['root:new'] && <span className="wd-repos-error">{rowError['root:new']}</span>}
        <span className="wd-repos-cost">
          Each enrolled repo is checked for pull requests every 2 minutes, so leave out what you don't work on.
        </span>
      </section>

      {pending && (
        <div className="wd-repos-confirm" role="alertdialog" aria-label="Confirm">
          <span>{pending.text}</span>
          <button type="button" className="wd-btn-danger" onClick={() => act(pending.key, pending.force)}>
            Do it anyway
          </button>
          <button type="button" className="wd-btn-secondary" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="wd-tab-empty">{shownFilter === 'new' ? 'Nothing new in the scanned folders.' : 'None.'}</p>
      ) : (
        <ul className="wd-repos-list">
          {rows.map((r) => {
            const key = r.alias ?? r.path;
            const alias = aliases[r.path] ?? r.suggestedAlias ?? '';
            const problem = r.status === 'new' ? enrollProblem(alias, r.path, config) : null;
            return (
              <li key={key} className={`wd-repos-row wd-repos-${r.status}`}>
                <span className="wd-repos-name">
                  <span className="wd-repos-folder">{r.folder}</span>
                  <span className="wd-repos-path" title={r.path}>
                    {r.path}
                  </span>
                </span>
                <span className="wd-repos-origin">{r.origin ?? ''}</span>
                <span className="wd-repos-state">
                  {r.status === 'new' ? (
                    <input
                      className="wd-repos-alias"
                      value={alias}
                      aria-label={`Alias for ${r.folder}`}
                      onChange={(e) => setAliases((m) => ({ ...m, [r.path]: e.target.value }))}
                    />
                  ) : r.status === 'ignored' ? (
                    <span className="wd-tab-header-muted">ignored</span>
                  ) : (
                    <>
                      <span className="wd-repos-alias-name">{r.alias}</span>
                      {r.groups.map((g) => (
                        <span key={g} className="wd-repos-chip" title="In this group">
                          {g}
                        </span>
                      ))}
                      {r.sessions > 0 && (
                        <span className="wd-tab-header-muted">
                          {r.sessions} session{r.sessions === 1 ? '' : 's'}
                        </span>
                      )}
                      {r.status === 'missing' && <span className="wd-repos-warn">folder gone</span>}
                      {r.sharedWith?.length ? <span className="wd-repos-warn">same folder as {r.sharedWith.join(', ')}</span> : null}
                    </>
                  )}
                </span>
                <span className="wd-repos-actions">
                  {r.status === 'new' && (
                    <>
                      <button
                        type="button"
                        className="wd-btn-secondary"
                        disabled={!!problem || busy === key}
                        title={problem ?? `Enrol it as ${alias}`}
                        onClick={() => act(key, () => api.enroll(alias, r.path))}
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        className="wd-link-button"
                        disabled={busy === key}
                        onClick={() => act(key, () => api.ignore(r.path, true))}
                      >
                        Ignore
                      </button>
                    </>
                  )}
                  {r.status === 'ignored' && (
                    <button
                      type="button"
                      className="wd-link-button"
                      disabled={busy === key}
                      onClick={() => act(key, () => api.ignore(r.path, false))}
                    >
                      Unignore
                    </button>
                  )}
                  {(r.status === 'enrolled' || r.status === 'missing') && (
                    <button
                      type="button"
                      className="wd-link-button wd-repos-remove"
                      disabled={busy === key}
                      title="Stop knowing it (the folder stays); it leaves its groups"
                      onClick={() =>
                        act(
                          key,
                          () => api.remove(r.alias!),
                          () => api.remove(r.alias!, true),
                        )
                      }
                    >
                      Remove
                    </button>
                  )}
                </span>
                {(problem || rowError[key]) && <span className="wd-repos-error">{rowError[key] ?? problem}</span>}
              </li>
            );
          })}
        </ul>
      )}

      <Groups data={data} config={config} act={act} api={api} busy={busy} rowError={rowError} />
    </div>
  );
}

/** The groups: their repos (×, + add), sessions, Delete; and a new one. */
function Groups({
  data,
  config,
  act,
  api,
  busy,
  rowError,
}: {
  data: ReposWire;
  config: { repos: Record<string, string>; groups: Record<string, string[]> };
  act: (key: string, fn: () => Promise<void>, force?: () => Promise<void>) => void;
  api: ReposApi;
  busy: string | null;
  rowError: Record<string, string>;
}) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const enrolled = Object.keys(config.repos).sort();
  const newProblem = name.trim() ? groupProblem(name.trim(), picked, config, { creating: true }) : null;
  const change = (g: GroupRow, members: string[]) => act(`group:${g.name}`, () => api.saveGroup(g.name, members, false));
  return (
    <section className="wd-repos-groups" aria-label="Groups">
      <h2 className="wd-start-title">Groups</h2>
      <p className="wd-repos-hint">
        A group's sessions get a worktree of every repo in it. Its name stays (its sessions and folders carry it); changing its repos
        applies to new sessions.
      </p>
      <ul className="wd-repos-list">
        {data.groups.map((g) => {
          const others = enrolled.filter((a) => !g.members.includes(a));
          return (
            <li key={g.name} className="wd-repos-row wd-repos-group">
              <span className="wd-repos-name">
                <span className="wd-repos-folder">{g.name}</span>
                {g.sessions > 0 && (
                  <span className="wd-repos-path">
                    {g.sessions} session{g.sessions === 1 ? '' : 's'}
                  </span>
                )}
              </span>
              <span className="wd-repos-members">
                {g.members.map((m) => (
                  <span key={m} className={'wd-repos-chip' + (g.missing.includes(m) ? ' wd-repos-chip-bad' : '')}>
                    {m}
                    <button
                      type="button"
                      className="wd-link-button"
                      aria-label={`Take ${m} out of ${g.name}`}
                      disabled={busy === `group:${g.name}`}
                      onClick={() =>
                        change(
                          g,
                          g.members.filter((x) => x !== m),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                {others.length > 0 && (
                  <select
                    aria-label={`Add a repo to ${g.name}`}
                    value=""
                    disabled={busy === `group:${g.name}`}
                    onChange={(e) => e.target.value && change(g, [...g.members, e.target.value])}
                  >
                    <option value="">+ add</option>
                    {others.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                )}
              </span>
              <span className="wd-repos-actions">
                <button
                  type="button"
                  className="wd-link-button wd-repos-remove"
                  disabled={busy === `group:${g.name}`}
                  title="Delete the group (its repos stay)"
                  onClick={() =>
                    act(
                      `group:${g.name}`,
                      () => api.deleteGroup(g.name),
                      () => api.deleteGroup(g.name, true),
                    )
                  }
                >
                  Delete
                </button>
              </span>
              {(g.problem || rowError[`group:${g.name}`]) && (
                <span className="wd-repos-error">{rowError[`group:${g.name}`] ?? g.problem}</span>
              )}
            </li>
          );
        })}
      </ul>
      <form
        className="wd-repos-newgroup"
        onSubmit={(e) => {
          e.preventDefault();
          if (newProblem || !name.trim()) return;
          act('group:new', () =>
            api.saveGroup(name.trim(), picked, true).then(() => {
              setName('');
              setPicked([]);
            }),
          );
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New group name" aria-label="New group name" />
        <span className="wd-repos-pick" role="group" aria-label="Repos in the new group">
          {enrolled.map((a) => (
            <label key={a} className={'wd-repos-chip' + (picked.includes(a) ? ' wd-repos-chip-on' : '')}>
              <input
                type="checkbox"
                checked={picked.includes(a)}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a] : p.filter((x) => x !== a)))}
              />
              {a}
            </label>
          ))}
        </span>
        <button
          type="submit"
          className="wd-btn-secondary"
          disabled={!name.trim() || !!newProblem || busy === 'group:new'}
          title={newProblem ?? undefined}
        >
          Create group
        </button>
        {name.trim() && (newProblem || rowError['group:new']) && (
          <span className="wd-repos-error">{rowError['group:new'] ?? newProblem}</span>
        )}
      </form>
    </section>
  );
}
