import type { PrDiscussionCommentWire, PrDiscussionThreadWire } from '../../../../core/api-types.js';
import { hostName } from '../../../../core/hosts/commands.js';
import { relativeTime } from '../../utils/time.js';
import { mdGist } from '../../state/review-view.js';
import { Markdown } from '../Markdown.js';

/** "MEMBER" → "member": how the host relates someone to the repo, quietly. */
const association = (a?: string) => (a && a !== 'NONE' ? a.toLowerCase().replace(/_/g, ' ') : '');

function HostComment({ c }: { c: PrDiscussionCommentWire }) {
  const rel = association(c.association);
  return (
    <div className="wd-host-comment">
      <div className="wd-host-comment-head">
        <strong>@{c.author}</strong>
        {rel && <span className="wd-host-assoc">{rel}</span>}
        {c.at && (
          <span className="wd-start-note" title={c.at}>
            {relativeTime(c.at)} ago
          </span>
        )}
      </div>
      <Markdown source={c.body} block className="wd-host-comment-body" />
    </div>
  );
}

/**
 * A review thread already on the PR (its host's), read only: who said what and when, resolved ones folded and dimmed,
 * an outdated one marked. Visibly not a draft — no Delete, Reply or Resolve; its link opens it on the host, where it
 * is answered.
 */
export function HostThread({ thread: t, host, where }: { thread: PrDiscussionThreadWire; host?: string; where?: string }) {
  const name = hostName(host);
  const first = t.comments[0];
  const state = (
    <span className="wd-host-thread-state">
      <span className="wd-host-badge">on {name}</span>
      {where && <span className="wd-host-where">{where}</span>}
      <span className={t.resolved ? 'wd-host-resolved' : 'wd-host-open'}>{t.resolved ? 'resolved' : 'open'}</span>
      {t.outdated && (
        <span className="wd-host-outdated" title="The code moved on under it since: its line may be gone">
          outdated
        </span>
      )}
      <span className="wd-start-note">
        {t.comments.length} comment{t.comments.length === 1 ? '' : 's'}
      </span>
    </span>
  );
  const link = t.url && (
    <a className="wd-host-link" href={t.url} target="_blank" rel="noreferrer">
      Open on {name} ↗
    </a>
  );
  return (
    <details
      className={`wd-host-thread${t.resolved ? ' wd-host-thread-resolved' : ''}${t.outdated ? ' wd-host-thread-outdated' : ''}`}
      open={!t.resolved}
      data-thread={t.id}
    >
      <summary>
        {state}
        {t.resolved && first && (
          <span className="wd-host-gist">
            @{first.author}: {mdGist(first.body, 100)}
          </span>
        )}
      </summary>
      {t.comments.map((c, i) => (
        <HostComment key={i} c={c} />
      ))}
      {link}
    </details>
  );
}

/** The threads on a line, one under another. */
export function HostThreads({ threads, host }: { threads: PrDiscussionThreadWire[]; host?: string }) {
  if (!threads.length) return null;
  return (
    <div className="wd-host-threads">
      {threads.map((t) => (
        <HostThread key={t.id} thread={t} {...(host ? { host } : {})} />
      ))}
    </div>
  );
}
