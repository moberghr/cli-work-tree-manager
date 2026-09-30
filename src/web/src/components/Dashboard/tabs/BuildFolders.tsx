import { useCallback, useEffect, useState } from 'react';
import type { BuildFoldersApplyResult, BuildFoldersState } from '../../../../../core/api-types.js';
import { relativeTime } from '../../../utils/time.js';

export interface BuildFoldersApi {
  state(): Promise<BuildFoldersState>;
  scan(): Promise<BuildFoldersState>;
  apply(sessionIds: string[]): Promise<{ results: BuildFoldersApplyResult[]; state: BuildFoldersState }>;
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

export const httpBuildFoldersApi: BuildFoldersApi = {
  state: () => call('GET', '/api/cleanup/build-folders'),
  scan: () => call('POST', '/api/cleanup/build-folders/scan'),
  apply: (sessionIds) => call('POST', '/api/cleanup/build-folders/apply', { sessionIds }),
};

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/**
 * Space without archiving: node_modules, bin/obj, .next, … in worktrees you
 * haven't used for a week. Only folders git ignores are listed and removed
 * (checked again right before); the next install or build brings them back.
 */
export function BuildFolders({ api = httpBuildFoldersApi, pollMs = 1000 }: { api?: BuildFoldersApi; pollMs?: number }) {
  const [st, setSt] = useState<BuildFoldersState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback((p: Promise<BuildFoldersState>) => p.then(setSt, (e: Error) => setError(e.message)), []);
  useEffect(() => void load(api.state()), [api, load]);
  useEffect(() => {
    if (!st?.scanning) return;
    const t = setInterval(() => void load(api.state()), pollMs);
    return () => clearInterval(t);
  }, [st?.scanning, api, load, pollMs]);

  const clear = async (ids: string[]) => {
    setClearing(ids);
    setNote(null);
    try {
      const r = await api.apply(ids);
      setSt(r.state);
      const bad = r.results.filter((x) => !x.ok);
      setNote(bad.length ? `${bad.length} left alone: ${bad.map((b) => b.message).join('; ')}` : `Cleared ${r.results.length} worktree${r.results.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClearing([]);
    }
  };

  const list = st?.candidates ?? [];
  const total = list.reduce((n, c) => n + c.bytes, 0);
  return (
    <section className="wd-cleanup-section wd-cleanup-build">
      <h2 className="wd-inbox-section-title" title="node_modules, bin/obj, .next, target… that git ignores, in worktrees idle a week or more">
        Build folders in idle worktrees{' '}
        {st?.scannedAt && !st.scanning && <span className="wd-tab-header-muted">({formatBytes(total)} in {list.length}, measured {relativeTime(st.scannedAt)})</span>}
        <button type="button" className="wd-row-action" disabled={!!st?.scanning} onClick={() => void load(api.scan())}>
          {st?.scanning ? `Measuring ${st.checked} of ${st.total || '…'}…` : st?.scannedAt ? 'Measure again' : 'Measure'}
        </button>
        {list.length > 0 && !st?.scanning && (
          <button type="button" className="wd-row-action wd-row-action-danger" disabled={clearing.length > 0} onClick={() => void clear(list.map((c) => c.sessionId))}>
            Clear all ({formatBytes(total)})
          </button>
        )}
      </h2>
      <p className="wd-cleanup-hint">
        Frees space without archiving: only folders git ignores are removed, and the next install or build brings them back.
      </p>
      {error && <div className="wd-tab-error">{error}</div>}
      {note && <p className="wd-cleanup-hint" role="status">{note}</p>}
      {st?.scannedAt && list.length === 0 && !st.scanning && <p className="wd-cleanup-hint">Nothing to clear.</p>}
      <ul className="wd-cleanup-list">
        {list.map((c) => (
          <li key={c.sessionId} className="wd-cleanup-item">
            <span className="wd-cleanup-name">
              <span className="wd-inbox-target">{c.target}</span>
              <span className="wd-inbox-branch">{c.branch}</span>
              {c.baseCheckout && <span className="wd-tab-header-muted" title="The repo's own checkout, not a worktree"> · repo checkout</span>}
            </span>
            <span className="wd-cleanup-reason" title={c.folders.map((f) => `${formatBytes(f.bytes)}  ${f.path}`).join('\n')}>
              {formatBytes(c.bytes)} · {c.folders.slice(0, 3).map((f) => f.path.split(/[\\/]/).pop()).join(', ')}
              {c.folders.length > 3 ? ` +${c.folders.length - 3}` : ''}
            </span>
            <span className="wd-cleanup-when">{relativeTime(c.lastActive)}</span>
            <button type="button" className="wd-row-action" disabled={clearing.length > 0} onClick={() => void clear([c.sessionId])}>
              {clearing.includes(c.sessionId) ? 'Clearing…' : 'Clear'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
