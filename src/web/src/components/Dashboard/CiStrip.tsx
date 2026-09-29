import { useCallback, useEffect, useState } from 'react';
import { askClaudeToFixCi, fetchSessionCi, type SessionCi } from '../../api/client.js';
import { useSse } from '../../api/events.js';

const POLL_MS = 60_000;

/**
 * CI and review for the session's open PRs, under the header: open review
 * threads, failing checks by name (linked) with "Ask Claude to fix", or a
 * running marker. Nothing when there's no open PR or all is quiet. work web's PR watch already
 * tells Claude about a new failure by itself (config `prWatch.fixCi`);
 * the button is for asking again.
 */
export function CiStrip({ sessionId, isGroup }: { sessionId: string; isGroup: boolean }) {
  const [ci, setCi] = useState<SessionCi | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fetchSessionCi(sessionId).then(setCi, () => {});
  }, [sessionId]);
  useEffect(() => {
    setCi(null);
    setSent(false);
    setError(null);
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  useSse('/events', {
    events: {
      'ci-changed': (d) => {
        if ((d as { sessionId?: string } | null)?.sessionId === sessionId) load();
      },
    },
  });

  const open = (ci?.repos ?? []).filter((r) => r.pr?.state === 'OPEN');
  const failing = open.filter((r) => r.pr!.checks === 'fail');
  const running = open.filter((r) => r.pr!.checks === 'pending');
  const reviewed = open.filter((r) => (r.openThreads ?? 0) > 0);
  if (!failing.length && !running.length && !reviewed.length) return null;
  const label = (r: (typeof open)[number]) => `#${r.pr!.number}${isGroup ? ` ${r.name}` : ''}`;

  return (
    <div className={'wd-ci-strip' + (failing.length ? ' wd-ci-fail' : ' wd-ci-running')} role="status">
      {reviewed.map((r) => (
        <span key={`rv-${r.name}`} className="wd-ci-item" title="Unresolved review threads waiting on you or Claude — new ones are handed to Claude automatically">
          <span aria-hidden="true">💬</span>{' '}
          <a href={`${r.pr!.url}/files`} target="_blank" rel="noopener noreferrer">
            {r.openThreads} open review thread{r.openThreads === 1 ? '' : 's'}
          </a>{' '}
          on {label(r)}
        </span>
      ))}
      {failing.map((r) => (
        <span key={r.name} className="wd-ci-item">
          <span aria-hidden="true">✗</span> CI failing on{' '}
          <a href={r.pr!.url} target="_blank" rel="noopener noreferrer">
            {label(r)}
          </a>
          {r.pr!.failing?.length ? ': ' : ''}
          {r.pr!.failing?.map((f, i) => (
            <span key={f.name + i}>
              {i > 0 && ', '}
              {f.url ? (
                <a href={f.url} target="_blank" rel="noopener noreferrer">
                  {f.name}
                </a>
              ) : (
                f.name
              )}
            </span>
          ))}
        </span>
      ))}
      {running.map((r) => (
        <span key={r.name} className="wd-ci-item wd-tab-header-muted">
          <span aria-hidden="true">●</span> checks running on {label(r)}
        </span>
      ))}
      {failing.length > 0 &&
        (sent ? (
          <span className="wd-tab-header-muted">Sent to Claude ✓</span>
        ) : (
          <button
            type="button"
            className="wd-btn-secondary wd-ci-fix"
            disabled={sending}
            onClick={async () => {
              setSending(true);
              setError(null);
              try {
                await askClaudeToFixCi(sessionId);
                setSent(true);
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setSending(false);
              }
            }}
          >
            {sending ? 'Sending…' : 'Ask Claude to fix'}
          </button>
        ))}
      {error && <span className="wd-dev-error" role="alert">{error}</span>}
    </div>
  );
}
