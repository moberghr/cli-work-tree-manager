import { useEffect, useMemo, useState } from 'react';
import { fetchSessionHistory, type CheckpointEntry, type SessionCommit, type SessionSummary } from '../../api/client.js';
import { useSse } from '../../api/events.js';
import { branchTabRows, branchTitle, branchUnpushed, type BranchTabRow } from '../../state/branches.js';
import { stagePhrase } from '../../../../core/pr/pr-stage.js';
import { toneClass } from './SessionBits.js';
import { timeAgo } from '../../utils/time.js';

/**
 * Every branch the session worked on, per repo (session-branches.ts): what's known of it, the turns taken on it
 * and when, its commits (folded), and Show in Diff — its whole change, as the Diff tab's Branch select shows it
 * (the checked-out one: the Diff tab as it opens). Shown as a tab only when there's more than one branch.
 */
export function BranchesTab({
  session,
  onShowBranch,
  onShowDiff,
}: {
  session: SessionSummary;
  onShowBranch: (repo: string, name: string) => void;
  onShowDiff: () => void;
}) {
  const [history, setHistory] = useState<{ entries: CheckpointEntry[]; commits: SessionCommit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fetchSessionHistory(session.id).then(
      (h) => {
        if (!live) return;
        setHistory({ entries: h.entries, commits: h.commits });
        setError(null); // a read that failed before doesn't hide this one
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [session.id, tick]);
  // A turn's end (a new checkpoint) or a commit by hand moves the history: read it again.
  const again = () => setTick((t) => t + 1);
  useSse(`/events?session=${encodeURIComponent(session.id)}`, { events: { 'checkpoints-changed': again, 'diff-changed': again } });
  const repos = useMemo(() => (history ? branchTabRows(session, history.entries, history.commits) : []), [session, history]);
  if (error) return <p className="wd-modal-error">Couldn’t read its history: {error}</p>;
  if (!history) return <p className="wd-start-note wd-branches-tab-loading">Loading…</p>;
  return (
    <div className="wd-branches-tab">
      <h2 className="wd-branches-tab-title">Branches this session worked on</h2>
      {repos.length === 0 && (
        // Key 5 opens it whatever the session: one branch has nothing more to say than the header does.
        <p className="wd-start-note">Only one so far: {session.branch}. Another branch it checks out is listed here.</p>
      )}
      {repos.map((r) => (
        <section key={r.repo} className="wd-branches-tab-repo" aria-label={`Branches of ${r.repo}`}>
          {session.isGroup && <h3 className="wd-branches-tab-repo-name">{r.repo}</h3>}
          <ul>
            {r.rows.map((row) => (
              <BranchRow
                key={row.branch.name}
                row={row}
                onShow={() => (row.branch.current ? onShowDiff() : onShowBranch(row.branch.repo, row.branch.name))}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function BranchRow({ row, onShow }: { row: BranchTabRow; onShow: () => void }) {
  const [open, setOpen] = useState(false);
  const b = row.branch;
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const turns = row.turns;
  return (
    <li className={'wd-branches-tab-row' + (b.current ? ' wd-branches-tab-current' : '')}>
      <div className="wd-branches-tab-head">
        <span className={'wd-branches-tab-dot' + (b.current ? ' wd-branches-tab-dot-on' : '')} aria-hidden="true" />
        <span className="wd-branches-tab-name" title={branchTitle(b)}>
          {b.name}
        </span>
        {b.current && <span className="wd-branches-tab-tag">checked out</span>}
        {row.note && <span className={'wd-branches-tab-note' + (branchUnpushed(b) ? ' wd-branch-unpushed' : '')}>{row.note}</span>}
        {b.pr && (
          <a
            className={`wd-pr-chip wd-pr-stage${toneClass(b.pr.kind)}`}
            href={b.pr.url}
            target="_blank"
            rel="noreferrer"
            title={`Open #${b.pr.number}: ${stagePhrase(b.pr.kind)}`}
          >
            #{b.pr.number} · {stagePhrase(b.pr.kind)} ↗
          </a>
        )}
        <button type="button" className="wd-btn-secondary wd-branches-tab-show" onClick={onShow}>
          Show in Diff
        </button>
      </div>
      <div className="wd-branches-tab-meta">
        {turns ? (
          <span>
            {turns.count === 1 ? `turn ${turns.first}` : `turns ${turns.first}–${turns.last}`} ·{' '}
            {day(turns.from) === day(turns.to) ? day(turns.from) : `${day(turns.from)} → ${day(turns.to)}`}
          </span>
        ) : (
          <span>no turns recorded on it</span>
        )}
        {b.from && <span> · made from {b.from}</span>}
        {!b.current && <span> · last here {timeAgo(b.lastSeen)}</span>}
      </div>
      {row.commits.length > 0 && (
        <div className="wd-branches-tab-commits">
          <button type="button" className="wd-link-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? '▾' : '▸'} {row.commits.length} commit{row.commits.length === 1 ? '' : 's'}
          </button>
          {open && (
            <ul>
              {row.commits.map((c) => (
                <li key={c.sha}>
                  <code>{c.sha.slice(0, 7)}</code> {c.subject} <span className="wd-start-note">· {timeAgo(c.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
