import {
  selectCommentsForLine,
  useReview,
} from '../../state/ReviewProvider.js';
import { Composer } from './Composer.js';
import { CommentItem } from './CommentItem.js';

interface SideContent {
  comments: ReturnType<typeof selectCommentsForLine>;
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
export function CommentLineRow({
  repo,
  file,
  oldLine,
  oldContent,
  newLine,
  newContent,
}: Props) {
  const review = useReview();

  const left = oldLine !== null
    ? {
        comments: selectCommentsForLine(review.comments, repo, file, oldLine, 'left'),
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
  const right = newLine !== null
    ? {
        comments: selectCommentsForLine(review.comments, repo, file, newLine, 'right'),
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

  const leftActive = !!left && (left.comments.length > 0 || left.composerOpen);
  const rightActive = !!right && (right.comments.length > 0 || right.composerOpen);
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

function SidePanel({
  repo,
  file,
  side,
}: {
  repo: string;
  file: string;
  side: SideContent;
}) {
  const review = useReview();
  return (
    <div className="wd-comment-list">
      {side.comments.map((c) => (
        <CommentItem
          key={c.id}
          comment={c}
          currentLineContent={side.lineContent}
        />
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
