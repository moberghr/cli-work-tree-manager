import type { PrDiscussionThreadWire, PrDiscussionWire } from '../../../../../../core/api-types.js';
import { hostName } from '../../../../../../core/hosts/commands.js';
import { discussionCounts } from '../../../../../../core/review/review-discussion.js';
import { timeAgo } from '../../../../utils/time.js';
import { mdGist } from '../../../../state/review-view.js';
import { HostThread } from '../../../Review/HostThread.js';

/** Where a thread is, as a list beside the diff says it: "Rounding.cs (was line 3)". */
export function threadWhere(t: PrDiscussionThreadWire): string {
  const name = t.path ? t.path.split('/').pop()! : 'the whole PR';
  if (t.line !== null) return `${name}:${t.line}${t.side === 'left' ? ' (old side)' : ''}`;
  return t.originalLine ? `${name} (was line ${t.originalLine})` : name;
}

/**
 * The PR's threads that can't sit on a line of this diff — outdated (the code moved on under them), on a whole file,
 * or on a line the diff doesn't show — listed together so none is lost. Read only.
 */
export function DiscussionAside({ threads, host }: { threads: PrDiscussionThreadWire[]; host?: string }) {
  const open = threads.filter((t) => !t.resolved).length;
  return (
    <details className="wd-host-aside" open={open > 0}>
      <summary>
        {threads.length} thread{threads.length === 1 ? '' : 's'} on {hostName(host)} not on a line of this diff
        <span className="wd-start-note"> · {open} open · outdated, or on lines the diff doesn&apos;t show</span>
      </summary>
      {threads.map((t) => (
        <HostThread key={t.id} thread={t} where={threadWhere(t)} {...(host ? { host } : {})} />
      ))}
    </details>
  );
}

/**
 * The overview's "Already discussed": how many threads the PR has on its host and how many are open, who approved or
 * asked for changes (their latest verdict), the reviews and conversation comments as one line each with their links,
 * and the threads that aren't on a line of the diff. Read only — answered on the host.
 */
export function AlreadyDiscussed({
  discussion: d,
  host,
  aside,
  onFiles,
}: {
  discussion: PrDiscussionWire | undefined;
  host?: string;
  aside: PrDiscussionThreadWire[];
  /** Opens the Files view (where the threads sit on their lines). */
  onFiles: () => void;
}) {
  const name = hostName(host);
  if (!d)
    return (
      <section className="wd-review-discussed" aria-label="Already discussed">
        <h3>Already discussed</h3>
        <p className="wd-start-note">Not read from {name} yet: it is read when the review is prepared again.</p>
      </section>
    );
  const c = discussionCounts(d);
  const verdicts = [...d.reviews].filter((r) => r.state !== 'commented' || r.body.trim()).sort((a, b) => b.at.localeCompare(a.at));
  const nothing = !c.threads && !c.comments && !d.reviews.length;
  return (
    <section className="wd-review-discussed" aria-label="Already discussed">
      <h3>
        Already discussed{' '}
        <span className="wd-start-note">
          · on {name}, read {timeAgo(d.at)}
          {d.more ? ' · more on the host than shown' : ''}
        </span>
      </h3>
      {nothing ? (
        <p className="wd-start-note">Nobody has commented on the PR yet.</p>
      ) : (
        <p className="wd-review-discussed-line">
          <strong>
            {c.threads} thread{c.threads === 1 ? '' : 's'}, {c.open} open
          </strong>
          {c.resolved > 0 && ` · ${c.resolved} resolved`}
          {c.outdated > 0 && ` · ${c.outdated} outdated`}
          {c.comments > 0 && ` · ${c.comments} comment${c.comments === 1 ? '' : 's'} on the PR`}
          {c.approved.length > 0 && <span className="wd-host-approved"> · approved by {c.approved.map((a) => `@${a}`).join(', ')}</span>}
          {c.changes.length > 0 && (
            <span className="wd-host-changes"> · changes requested by {c.changes.map((a) => `@${a}`).join(', ')}</span>
          )}
          {c.threads > 0 && (
            <>
              {' '}
              <button type="button" className="wd-link-button" onClick={onFiles}>
                See them on their lines →
              </button>
            </>
          )}
        </p>
      )}
      {(verdicts.length > 0 || d.comments.length > 0) && (
        <ul className="wd-review-discussed-list">
          {verdicts.map((r, i) => (
            <li key={`r${i}`}>
              <span className={`wd-host-verdict wd-host-verdict-${r.state}`}>
                {r.state === 'changes-requested' ? 'changes requested' : r.state}
              </span>{' '}
              <strong>@{r.author}</strong>
              {r.body.trim() && <span className="wd-review-gist"> {mdGist(r.body, 160)}</span>}{' '}
              {r.at && <span className="wd-start-note">{timeAgo(r.at)}</span>}{' '}
              {r.url && (
                <a href={r.url} target="_blank" rel="noreferrer" title={`Open on ${name}`}>
                  ↗
                </a>
              )}
            </li>
          ))}
          {[...d.comments]
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((x, i) => (
              <li key={`c${i}`}>
                <span className="wd-host-verdict wd-host-verdict-comment">comment</span> <strong>@{x.author}</strong>
                <span className="wd-review-gist"> {mdGist(x.body, 160)}</span>{' '}
                {x.at && <span className="wd-start-note">{timeAgo(x.at)}</span>}{' '}
                {x.url && (
                  <a href={x.url} target="_blank" rel="noreferrer" title={`Open on ${name}`}>
                    ↗
                  </a>
                )}
              </li>
            ))}
        </ul>
      )}
      {aside.length > 0 && <DiscussionAside threads={aside} {...(host ? { host } : {})} />}
    </section>
  );
}
