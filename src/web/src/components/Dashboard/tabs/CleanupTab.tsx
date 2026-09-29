import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CleanupAction, CleanupCandidate, CleanupState } from '../../../api/client.js';
import { relativeTime } from '../../../utils/time.js';

interface Props {
  onOpenSession: (id: string) => void;
  /** Test seams; default to the API. */
  api?: CleanupApi;
  pollMs?: number;
}

export interface CleanupApi {
  state(): Promise<CleanupState>;
  scan(): Promise<CleanupState>;
  apply(items: Array<{ sessionId: string; action: CleanupAction }>): Promise<CleanupState>;
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<CleanupState> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as CleanupState & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${path}: ${res.status}`);
  return json;
}

export const httpCleanupApi: CleanupApi = {
  state: () => call('GET', '/api/cleanup'),
  scan: () => call('POST', '/api/cleanup/scan'),
  apply: (items) => call('POST', '/api/cleanup/apply', { items }),
};

/** What each verdict may do, first = default. */
const ALLOWED: Record<CleanupCandidate['verdict'], CleanupAction[]> = {
  merged: ['delete', 'archive'],
  gone: ['forget'],
  work: ['archive'],
  dirty: ['archive'],
  keep: [],
};
const ACTION_LABEL: Record<CleanupAction, string> = { delete: 'Remove worktree', archive: 'Archive', forget: 'Forget session' };

const SECTIONS: Array<{ key: string; title: string; hint: string; verdicts: CleanupCandidate['verdict'][] }> = [
  {
    key: 'safe',
    title: 'Safe to remove',
    hint: 'Nothing uncommitted, nothing that isn’t already in the main branch (or the folder is gone). The branch itself is kept.',
    verdicts: ['merged', 'gone'],
  },
  {
    key: 'work',
    title: 'Has work of its own',
    hint: 'Uncommitted files or commits not in the main branch. Never removed from here; archive hides them and stops their Claude, keeping everything.',
    verdicts: ['dirty', 'work'],
  },
];

const busyText = (st: CleanupState) =>
  st.phase === 'fetching'
    ? 'Fetching from origin…'
    : st.phase === 'scanning'
      ? `Checking ${st.done} of ${st.total} worktrees…`
      : st.phase === 'applying'
        ? `Working through ${st.done} of ${st.total}…`
        : '';

/**
 * Clean up: which worktrees can go, and why — then remove, archive or forget
 * the chosen ones in one go. The server re-checks each one right before it
 * acts, so a worktree that got a new file since the scan is left alone.
 */
export function CleanupTab({ onOpenSession, api = httpCleanupApi, pollMs = 800 }: Props) {
  const [st, setSt] = useState<CleanupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // sessionId → chosen action (absent = not selected)
  const [chosen, setChosen] = useState<Record<string, CleanupAction>>({});
  const [confirming, setConfirming] = useState(false);
  const seededFrom = useRef<string | null>(null);

  const load = useCallback(
    (p: Promise<CleanupState>) =>
      p.then(
        (s) => {
          setSt(s);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [],
  );

  // First visit: scan if there is no result yet.
  useEffect(() => {
    api.state().then(
      (s) => {
        setSt(s);
        if (s.phase === 'idle' && !s.finishedAt) void load(api.scan());
      },
      (e: Error) => setError(e.message),
    );
  }, [api, load]);

  // Poll while the job runs.
  const busy = !!st && st.phase !== 'idle';
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(api.state()), pollMs);
    return () => clearInterval(t);
  }, [busy, api, load, pollMs]);

  // Pre-select the suggestions of each new scan result.
  useEffect(() => {
    if (!st || st.phase !== 'idle' || !st.finishedAt || seededFrom.current === st.finishedAt) return;
    seededFrom.current = st.finishedAt;
    const next: Record<string, CleanupAction> = {};
    for (const c of st.candidates) if (c.suggested) next[c.sessionId] = c.suggested;
    setChosen(next);
  }, [st]);

  const candidates = st?.candidates ?? [];
  const selected = useMemo(() => candidates.filter((c) => chosen[c.sessionId]), [candidates, chosen]);
  const tally = useMemo(() => {
    const t: Record<CleanupAction, number> = { delete: 0, archive: 0, forget: 0 };
    for (const c of selected) t[chosen[c.sessionId]]++;
    return t;
  }, [selected, chosen]);
  const summary = (Object.keys(tally) as CleanupAction[])
    .filter((a) => tally[a] > 0)
    .map((a) => `${a === 'delete' ? 'remove' : a} ${tally[a]}`)
    .join(' · ');

  const toggle = (c: CleanupCandidate, on: boolean) =>
    setChosen((prev) => {
      const next = { ...prev };
      if (on) next[c.sessionId] = prev[c.sessionId] ?? ALLOWED[c.verdict][0];
      else delete next[c.sessionId];
      return next;
    });
  const setAll = (list: CleanupCandidate[], on: boolean) =>
    setChosen((prev) => {
      const next = { ...prev };
      for (const c of list) {
        if (ALLOWED[c.verdict].length === 0 || (c.verdict !== 'merged' && c.verdict !== 'gone' && c.archivedAt)) continue;
        if (on) next[c.sessionId] = prev[c.sessionId] ?? ALLOWED[c.verdict][0];
        else delete next[c.sessionId];
      }
      return next;
    });

  const apply = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    void load(api.apply(selected.map((c) => ({ sessionId: c.sessionId, action: chosen[c.sessionId] }))));
  };

  const failed = (st?.results ?? []).filter((r) => !r.ok);
  const succeeded = (st?.results ?? []).filter((r) => r.ok).length;

  return (
    <div className="wd-dash-tab-pane wd-tab-cleanup">
      <header className="wd-tab-header">
        <h1>
          Clean up{' '}
          {st && !busy && (
            <span className="wd-tab-header-muted">
              ({candidates.length} worktree{candidates.length === 1 ? '' : 's'} to look at
              {st.finishedAt ? `, checked ${relativeTime(st.finishedAt)}` : ''})
            </span>
          )}
        </h1>
        <div className="wd-tab-controls">
          {busy && (
            <span className="wd-cleanup-progress" role="status">
              {busyText(st!)}
            </span>
          )}
          <button type="button" className="wd-btn-secondary" disabled={busy} onClick={() => void load(api.scan())}>
            {st?.finishedAt ? 'Check again' : 'Check'}
          </button>
        </div>
      </header>

      {error && <div className="wd-tab-error">{error}</div>}
      {st?.error && <div className="wd-tab-error">The last run failed: {st.error}</div>}

      {st && st.results.length > 0 && !busy && (
        <div className="wd-cleanup-results" role="status">
          {succeeded > 0 && <p>{succeeded} done.</p>}
          {failed.length > 0 && (
            <>
              <p>{failed.length} left alone:</p>
              <ul>
                {failed.map((r) => (
                  <li key={r.sessionId}>
                    <code>{r.sessionId}</code> — {r.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {!st ? (
        <div className="wd-tab-empty">Loading…</div>
      ) : st.phase !== 'idle' && candidates.length === 0 ? (
        <div className="wd-tab-empty">{busyText(st)}</div>
      ) : candidates.length === 0 ? (
        <div className="wd-tab-empty">Nothing to clean up: every worktree was used in the last day or has work of its own that is recent.</div>
      ) : (
        SECTIONS.map((sec) => {
          const list = candidates.filter((c) => sec.verdicts.includes(c.verdict));
          if (list.length === 0) return null;
          return (
            <section key={sec.key} className={`wd-cleanup-section wd-cleanup-${sec.key}`}>
              <h2 className="wd-inbox-section-title" title={sec.hint}>
                {sec.title} <span className="wd-tab-header-muted">({list.length})</span>
                <button type="button" className="wd-row-action" onClick={() => setAll(list, true)}>
                  Select all
                </button>
                <button type="button" className="wd-row-action" onClick={() => setAll(list, false)}>
                  None
                </button>
              </h2>
              <p className="wd-cleanup-hint">{sec.hint}</p>
              <ul className="wd-cleanup-list">
                {list.map((c) => {
                  const allowed = c.verdict === 'merged' || c.verdict === 'gone' ? ALLOWED[c.verdict] : c.archivedAt ? [] : ALLOWED[c.verdict];
                  const action = chosen[c.sessionId];
                  return (
                    <li key={c.sessionId} className={'wd-cleanup-item' + (action ? ' wd-cleanup-item-on' : '')}>
                      <label className="wd-cleanup-check">
                        <input
                          type="checkbox"
                          checked={!!action}
                          disabled={allowed.length === 0 || busy}
                          onChange={(e) => toggle(c, e.target.checked)}
                          aria-label={`Select ${c.target} ${c.branch}`}
                        />
                      </label>
                      <button type="button" className="wd-cleanup-name" onClick={() => onOpenSession(c.sessionId)} title="Open the session">
                        <span className="wd-inbox-target">{c.target}</span>
                        <span className="wd-inbox-branch">{c.branch}</span>
                      </button>
                      <span className="wd-cleanup-reason" title={c.repos.map((r) => `${r.name}: ${r.path}`).join('\n')}>
                        {c.reason}
                      </span>
                      <span className="wd-cleanup-when">{relativeTime(c.lastActive)}</span>
                      {allowed.length > 1 ? (
                        <select
                          value={action ?? allowed[0]}
                          disabled={!action || busy}
                          onChange={(e) => setChosen((p) => ({ ...p, [c.sessionId]: e.target.value as CleanupAction }))}
                          aria-label="Action"
                        >
                          {allowed.map((a) => (
                            <option key={a} value={a}>
                              {ACTION_LABEL[a]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="wd-cleanup-action">{allowed[0] ? ACTION_LABEL[allowed[0]] : c.archivedAt ? 'archived' : ''}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}

      {selected.length > 0 && (
        <footer className="wd-cleanup-bar">
          <span>
            {selected.length} selected: {summary}
          </span>
          {confirming && <span className="wd-cleanup-confirm-hint">Each is checked again before anything happens.</span>}
          <button type="button" className="wd-row-action" onClick={() => setConfirming(false)} disabled={!confirming}>
            Cancel
          </button>
          <button type="button" className={confirming ? 'wd-btn-danger' : 'wd-btn-primary'} disabled={busy} onClick={apply}>
            {confirming ? `Confirm: ${summary}` : 'Apply'}
          </button>
        </footer>
      )}
    </div>
  );
}
