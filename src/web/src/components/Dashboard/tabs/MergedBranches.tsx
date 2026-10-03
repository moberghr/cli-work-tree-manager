import { useCallback, useEffect, useState } from 'react';
import type { BranchesState } from '../../../../../core/api-types.js';
import { relativeTime } from '../../../utils/time.js';

/** A branch to delete, with the tip you were shown (it is refused if it moved). */
type Item = { repo: string; branch: string; tip: string };
type ApplyResult = { repo: string; branch: string; ok: boolean; message: string };

export interface MergedBranchesApi {
  state(): Promise<BranchesState>;
  scan(): Promise<BranchesState>;
  apply(items: Item[]): Promise<{ results: ApplyResult[]; state: BranchesState }>;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${path}: ${res.status}`);
  return json;
}

export const httpMergedBranchesApi: MergedBranchesApi = {
  state: () => call('GET', '/api/cleanup/branches'),
  scan: () => call('POST', '/api/cleanup/branches/scan'),
  apply: (items) => call('POST', '/api/cleanup/branches/apply', { items }),
};

/**
 * Local branches whose work is already in the main branch (merged, or a
 * squash-merged PR whose head is exactly the branch's tip). Deleting one
 * loses nothing; each is checked again before it goes.
 */
export function MergedBranches({ api = httpMergedBranchesApi, pollMs = 1000 }: { api?: MergedBranchesApi; pollMs?: number }) {
  const [st, setSt] = useState<BranchesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const load = useCallback((p: Promise<BranchesState>) => p.then(setSt, (e: Error) => setError(e.message)), []);
  useEffect(() => void load(api.state()), [api, load]);
  useEffect(() => {
    if (!st?.scanning) return;
    const t = setInterval(() => void load(api.state()), pollMs);
    return () => clearInterval(t);
  }, [st?.scanning, api, load, pollMs]);

  const del = async (items: Item[]) => {
    setBusy(true);
    setArmed(false);
    setNote(null);
    try {
      const r = await api.apply(items);
      setSt(r.state);
      const bad = r.results.filter((x) => !x.ok);
      setNote(
        bad.length
          ? `${bad.length} kept: ${bad.map((b) => `${b.branch} (${b.message})`).join('; ')}`
          : `Deleted ${r.results.length} branch${r.results.length === 1 ? '' : 'es'}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const list = st?.candidates ?? [];
  const safe = list.filter((b) => !b.archivedSession);
  return (
    <section className="wd-cleanup-section wd-cleanup-branches">
      <h2 className="wd-inbox-section-title" title="Local branches whose work is already in the main branch">
        Merged local branches{' '}
        {st?.scannedAt && !st.scanning && (
          <span className="wd-tab-header-muted">
            ({list.length}, checked {relativeTime(st.scannedAt)})
          </span>
        )}
        <button type="button" className="wd-row-action" disabled={!!st?.scanning} onClick={() => void load(api.scan())}>
          {st?.scanning ? 'Checking…' : st?.scannedAt ? 'Check again' : 'Check'}
        </button>
        {safe.length > 0 && !st?.scanning && (
          <button
            type="button"
            className="wd-row-action wd-row-action-danger"
            disabled={busy}
            onClick={() => (armed ? void del(safe.map(({ repo, branch, tip }) => ({ repo, branch, tip }))) : setArmed(true))}
          >
            {armed ? `Really delete ${safe.length}?` : `Delete ${safe.length}`}
          </button>
        )}
      </h2>
      <p className="wd-cleanup-hint">
        Merged into the main branch, or a squash-merged PR whose head is exactly the branch&apos;s tip. Nothing in them is lost.
      </p>
      {error && <div className="wd-tab-error">{error}</div>}
      {note && (
        <p className="wd-cleanup-hint" role="status">
          {note}
        </p>
      )}
      {st?.scannedAt && list.length === 0 && !st.scanning && <p className="wd-cleanup-hint">None.</p>}
      <ul className="wd-cleanup-list">
        {list.map((b) => (
          <li key={`${b.repo}/${b.branch}`} className="wd-cleanup-item">
            <span className="wd-cleanup-name">
              <span className="wd-inbox-target">{b.repo}</span>
              <span className="wd-inbox-branch">{b.branch}</span>
            </span>
            <span className="wd-cleanup-reason">
              {b.reason === 'merged' ? 'merged' : `squash-merged${b.prNumber ? ` in #${b.prNumber}` : ''}`}
              {b.archivedSession && ' · an archived session uses it: Restore would need it'}
            </span>
            <button
              type="button"
              className="wd-row-action"
              disabled={busy}
              onClick={() => void del([{ repo: b.repo, branch: b.branch, tip: b.tip }])}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
