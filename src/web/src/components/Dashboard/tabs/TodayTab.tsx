import { useCallback, useEffect, useRef, useState } from 'react';
import type { DigestResponse, DigestSession } from '../../../api/client.js';
import type { SessionSubTab } from '../../../state/dashboard-route.js';
import {
  STATE_LABEL,
  WINDOW_LABEL,
  digestMarkdown,
  totals,
  windowStart,
  type DigestWindow,
} from '../../../state/digest.js';

interface Props {
  onOpenSession: (id: string, sub: SessionSubTab) => void;
  /** Test seams; default to the API / the clipboard. */
  load?: (since: Date) => Promise<DigestResponse>;
  copy?: (text: string) => Promise<void>;
}

async function fetchDigest(since: Date): Promise<DigestResponse> {
  const res = await fetch(`/api/digest?since=${encodeURIComponent(since.toISOString())}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`digest: ${res.status}`);
  return res.json() as Promise<DigestResponse>;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const WINDOW_KEY = 'work-web:today-window';

function savedWindow(): DigestWindow {
  try {
    const v = localStorage.getItem(WINDOW_KEY);
    return v === 'yesterday' || v === 'week' ? v : 'today';
  } catch {
    return 'today';
  }
}

/**
 * Today: what each session did — the prompts you gave it, the turns it
 * finished, where it stands, its PRs. For a standup ("Copy as Markdown"),
 * or for coming back after a weekend.
 */
/** Deferred so a browser without `navigator.clipboard` (a non-secure
 *  context) rejects instead of throwing out of the click handler. */
const clipboardCopy = (t: string) => Promise.resolve().then(() => navigator.clipboard.writeText(t));

export function TodayTab({ onOpenSession, load = fetchDigest, copy = clipboardCopy }: Props) {
  const [win, setWin] = useState<DigestWindow>(savedWindow);
  const [data, setData] = useState<DigestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const request = useRef(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  const refresh = useCallback(() => {
    const n = ++request.current;
    setLoading(true);
    load(windowStart(win)).then(
      (d) => {
        if (n !== request.current) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (err: Error) => {
        if (n !== request.current) return;
        setError(err.message);
        setLoading(false);
      },
    );
  }, [win, load]);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    try {
      localStorage.setItem(WINDOW_KEY, win);
    } catch {
      /* per-viewer convenience only */
    }
  }, [win]);

  const onCopy = () => {
    if (!data) return;
    copy(digestMarkdown(data, WINDOW_LABEL[win])).then(
      () => setCopied('ok'),
      () => setCopied('failed'),
    );
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 2500);
  };

  const t = data ? totals(data) : null;
  return (
    <div className="wd-dash-tab-pane wd-tab-today">
      <header className="wd-tab-header">
        <h1>
          {WINDOW_LABEL[win]}{' '}
          {t && (
            <span className="wd-tab-header-muted">
              ({t.sessions} session{t.sessions === 1 ? '' : 's'} · {t.prompts} prompt{t.prompts === 1 ? '' : 's'} · {t.turns} turn
              {t.turns === 1 ? '' : 's'}
              {t.merged ? ` · ${t.merged} merged` : ''})
            </span>
          )}
        </h1>
        <div className="wd-tab-controls">
          <select value={win} onChange={(e) => setWin(e.target.value as DigestWindow)} aria-label="Time window">
            {(Object.keys(WINDOW_LABEL) as DigestWindow[]).map((w) => (
              <option key={w} value={w}>
                {WINDOW_LABEL[w]}
              </option>
            ))}
          </select>
          <button type="button" className="wd-btn-secondary" onClick={refresh} disabled={loading} title="Refresh">
            {loading ? 'Loading…' : '⟳'}
          </button>
          <button type="button" className="wd-btn-secondary" onClick={onCopy} disabled={!data || data.sessions.length === 0}>
            {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy as Markdown'}
          </button>
        </div>
      </header>
      {error && !data ? (
        <div className="wd-tab-error">{error}</div>
      ) : !data ? (
        <div className="wd-tab-empty">Loading…</div>
      ) : data.sessions.length === 0 ? (
        <div className="wd-tab-empty">No session did anything in this window.</div>
      ) : (
        <div className={'wd-today-list' + (loading ? ' wd-today-list-loading' : '')}>
          {data.sessions.map((s) => (
            <DigestCard key={s.sessionId} s={s} since={data.since} onOpen={onOpenSession} />
          ))}
        </div>
      )}
    </div>
  );
}

function DigestCard({ s, since, onOpen }: { s: DigestSession; since: string; onOpen: Props['onOpenSession'] }) {
  const sinceMs = Date.parse(since);
  return (
    <article className="wd-today-card">
      <header className="wd-today-card-header">
        <button type="button" className="wd-today-title" onClick={() => onOpen(s.sessionId, 'diff')}>
          <span className="wd-today-target">{s.target}</span> · <span className="wd-today-branch">{s.branch}</span>
        </button>
        <span className="wd-today-facts">
          {s.state && <span className={`wd-today-state wd-today-state-${s.state}`}>{STATE_LABEL[s.state]}</span>}
          {s.turns > 0 && (
            <span>
              {s.turns} turn{s.turns === 1 ? '' : 's'}
            </span>
          )}
          {!!s.diffStat?.files && (
            <span className="wd-diffstat" title="Uncommitted now">
              <span className="wd-diffstat-add">+{s.diffStat.added}</span> <span className="wd-diffstat-del">−{s.diffStat.deleted}</span>
            </span>
          )}
          {s.prs.map((p) => {
            // Merged inside the window is the news; a PR merged last week
            // on a reused branch name is just its state.
            const mergedNow = !!p.mergedAt && Date.parse(p.mergedAt) >= sinceMs;
            return (
              <a
                key={`${p.repo}#${p.number}`}
                className={'wd-today-pr' + (mergedNow ? ' wd-today-pr-merged' : '')}
                href={p.url}
                target="_blank"
                rel="noreferrer"
                title={mergedNow ? 'Merged in this window' : undefined}
              >
                #{p.number} {p.state.toLowerCase()}
              </a>
            );
          })}
          {s.archivedAt && <span className="wd-archived-pill">archived</span>}
        </span>
      </header>
      {s.prompts.length > 0 && (
        <section className="wd-today-section">
          <h3>You asked</h3>
          <ol className="wd-today-prompts">
            {s.partial && <li className="wd-today-more">Earlier prompts not shown: the transcript was too large to read back that far.</li>}
            {s.morePrompts > 0 && <li className="wd-today-more">…{s.morePrompts} earlier</li>}
            {s.prompts.map((p) => (
              <li key={p.ts + p.text}>
                <time dateTime={p.ts}>{clock(p.ts)}</time> {p.text}
              </li>
            ))}
          </ol>
        </section>
      )}
      {s.turnLabels.length > 0 ? (
        <section className="wd-today-section">
          <h3>Done</h3>
          <ul className="wd-today-done">
            {s.turnLabels.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      ) : (
        // While working, the status summary is the prompt itself (just listed).
        s.summary && s.state !== 'working' && <p className="wd-today-last">Last: {s.summary}</p>
      )}
    </article>
  );
}
