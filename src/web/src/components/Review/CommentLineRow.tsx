import { selectCommentsForLine, useReview } from '../../state/ReviewProvider.js';
import { Composer } from './Composer.js';
import { CommentItem } from './CommentItem.js';
import { HostThreads } from './HostThread.js';
import { hostThreadsAt, useHostThreads } from '../../state/HostThreads.js';
import type { PrDiscussionThreadWire } from '../../../../core/api-types.js';

export interface SideContent {
  comments: ReturnType<typeof selectCommentsForLine>;
  /** The PR's existing threads on its host on this line (the Reviews tab), read only; drawn above the drafts. */
  hostThreads?: PrDiscussionThreadWire[];
  composerOpen: boolean;
  lineContent: string;
  line: number;
  side: 'left' | 'right';
}

interface Props {
  repo: string;
  file: string;
  oldLine: number | null;
  oldContent: string;
  newLine: number | null;
  newContent: string;
}

/**
 * One injected `<tr>` placed right after a paired diff row. Each side
 * renders independently — left under the deleted/context line, right under
 * the added/context line. If no side has activity, the row isn't rendered
 * (caller decides via `hasActivity`).
 */
export function CommentLineRow({ repo, file, oldLine, oldContent, newLine, newContent }: Props) {
  const review = useReview();
  const host = useHostThreads();

  const left =
    oldLine !== null
      ? {
          comments: selectCommentsForLine(review.comments, repo, file, oldLine, 'left'),
          hostThreads: hostThreadsAt(host, file, 'left', oldLine),
          composerOpen:
            review.openComposer !== null &&
            review.openComposer.repo === repo &&
            review.openComposer.file === file &&
            review.openComposer.line === oldLine &&
            review.openComposer.side === 'left',
          lineContent: oldContent,
          line: oldLine,
          side: 'left' as const,
        }
      : null;
  const right =
    newLine !== null
      ? {
          comments: selectCommentsForLine(review.comments, repo, file, newLine, 'right'),
          hostThreads: hostThreadsAt(host, file, 'right', newLine),
          composerOpen:
            review.openComposer !== null &&
            review.openComposer.repo === repo &&
            review.openComposer.file === file &&
            review.openComposer.line === newLine &&
            review.openComposer.side === 'right',
          lineContent: newContent,
          line: newLine,
          side: 'right' as const,
        }
      : null;

  const leftActive = !!left && (left.comments.length > 0 || left.hostThreads.length > 0 || left.composerOpen);
  const rightActive = !!right && (right.comments.length > 0 || right.hostThreads.length > 0 || right.composerOpen);
  if (!leftActive && !rightActive) return null;

  return (
    <tr className="wd-comment-row">
      <td colSpan={2} className={leftActive ? 'wd-comment-side' : 'wd-comment-empty'}>
        {leftActive && left && <SidePanel repo={repo} file={file} side={left} />}
      </td>
      <td colSpan={2} className={rightActive ? 'wd-comment-side' : 'wd-comment-empty'}>
        {rightActive && right && <SidePanel repo={repo} file={file} side={right} />}
      </td>
    </tr>
  );
}

/**
 * One injected `<tr>` for the unified (inline) layout: a single full-width
 * cell carrying the thread + composer for one line. Unlike the split
 * `CommentLineRow` (which has a left and a right half), an inline row is a
 * single line on a single side — a deletion comments on `left`/oldNum, an
 * addition or context line on `right`/newNum. Renders nothing unless the
 * line has activity. `colSpan` spans the unified table's three columns.
 */
export function InlineCommentRow({
  repo,
  file,
  line,
  side,
  content,
}: {
  repo: string;
  file: string;
  line: number;
  side: 'left' | 'right';
  content: string;
}) {
  const review = useReview();
  const comments = selectCommentsForLine(review.comments, repo, file, line, side);
  const hostThreads = hostThreadsAt(useHostThreads(), file, side, line);
  const composerOpen =
    review.openComposer !== null &&
    review.openComposer.repo === repo &&
    review.openComposer.file === file &&
    review.openComposer.line === line &&
    review.openComposer.side === side;

  if (comments.length === 0 && hostThreads.length === 0 && !composerOpen) return null;

  const sideContent: SideContent = {
    comments,
    hostThreads,
    composerOpen,
    lineContent: content,
    line,
    side,
  };
  return (
    <tr className="wd-comment-row">
      <td colSpan={3} className="wd-comment-side">
        <SidePanel repo={repo} file={file} side={sideContent} />
      </td>
    </tr>
  );
}

export function SidePanel({ repo, file, side }: { repo: string; file: string; side: SideContent }) {
  const review = useReview();
  const host = useHostThreads();
  return (
    <div className="wd-comment-list">
      <HostThreads threads={side.hostThreads ?? []} {...(host?.host ? { host: host.host } : {})} />
      {side.comments.map((c) => (
        <CommentItem key={c.id} comment={c} currentLineContent={side.lineContent} />
      ))}
      {side.composerOpen && (
        <Composer
          context={`${repo}/${file} : line ${side.line} (${side.side})`}
          onSubmit={async (body, status) => {
            await review.postComment({
              repo,
              file,
              line: side.line,
              side: side.side,
              body,
              status,
              lineContent: side.lineContent,
            });
            review.closeComposer();
          }}
          onCancel={() => review.closeComposer()}
        />
      )}
    </div>
  );
}
