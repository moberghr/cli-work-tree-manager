import { useEffect, useRef, useState } from 'react';
import {
  fetchSessionDiff,
  type SessionDiff,
  type SessionSummary,
} from '../../api/client.js';
import { useSse } from '../../api/events.js';

interface Props {
  session: SessionSummary;
}

export function DiffView({ session }: Props) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Refetch counter — incremented on diff-changed SSE events to trigger reload.
  const [reloadKey, setReloadKey] = useState(0);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const myReq = ++reqIdRef.current;
    setError(null);
    fetchSessionDiff(session.id).then(
      (data) => {
        if (myReq !== reqIdRef.current) return;
        setDiff(data);
      },
      (err: Error) => {
        if (myReq !== reqIdRef.current) return;
        setError(err.message);
      },
    );
  }, [session.id, reloadKey]);

  useSse(`/events?session=${encodeURIComponent(session.id)}`, {
    events: {
      'diff-changed': () => setReloadKey((n) => n + 1),
    },
  });

  if (error) {
    return <div className="wd-web-error">{error}</div>;
  }
  if (!diff) {
    return <div className="wd-web-empty">Loading diff…</div>;
  }

  const totalFiles = diff.repos.reduce((s, r) => s + r.files.length, 0);
  return (
    <div className="wd-web-diff-placeholder">
      <h2>
        {session.target}
        <span className="wd-web-branch"> · {session.branch}</span>
      </h2>
      <p className="wd-web-muted">
        {totalFiles} file{totalFiles === 1 ? '' : 's'} changed across{' '}
        {diff.repos.length} repo{diff.repos.length === 1 ? '' : 's'}
      </p>
      <ul>
        {diff.repos.map((r) => (
          <li key={r.root}>
            <strong>{r.name}</strong>: {r.files.length} file
            {r.files.length === 1 ? '' : 's'}
            <ul>
              {r.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>{' '}
                  <span className="wd-web-add">+{f.added}</span>{' '}
                  <span className="wd-web-del">-{f.deleted}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="wd-web-muted">
        Full diff rendering (side-by-side, tree, hljs, intra-line) lands in the
        next batch of milestone 2.
      </p>
    </div>
  );
}
