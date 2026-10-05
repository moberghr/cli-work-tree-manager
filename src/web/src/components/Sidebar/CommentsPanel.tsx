import { useReview } from '../../state/ReviewProvider.js';
import type { Comment } from '../../api/client.js';

interface Props {
  /** The repo on screen (none: the diff is empty). Every repo's comments are listed; another repo's say which. */
  repoName?: string;
  /** Show another repo's diff (a click on one of its comments). */
  onOpenRepo?: (repo: string) => void;
}

/**
 * Every top-level comment of the review (replies render under their
 * parents inline): general ones, and line / file ones in every repo — not
 * only the one on screen, and also when the diff is empty (the Comments
 * tab was folded into the Diff, so this is the one list of them).
 */
export function CommentsPanel({ repoName, onOpenRepo }: Props) {
  const review = useReview();
  const entries = review.comments.filter((c) => !c.parentId);

  return (
    <div className="wd-comments-panel">
      <h3 className="wd-comments-panel-title">
        Comments <span className="wd-comments-panel-count">({entries.length})</span>
      </h3>
      {entries.length === 0 ? (
        <p className="wd-comments-panel-empty">No comments yet.</p>
      ) : (
        <ul className="wd-comments-panel-list">
          {entries.map((c) => (
            <CommentsPanelRow key={c.id} comment={c} repoName={repoName} onOpenRepo={onOpenRepo} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CommentsPanelRow({ comment, repoName, onOpenRepo }: { comment: Comment; repoName?: string; onOpenRepo?: (repo: string) => void }) {
  const elsewhere = comment.side !== 'general' && !!comment.repo && comment.repo !== repoName;
  function onClick() {
    if (elsewhere) {
      // Its repo first; the jump once that diff is drawn.
      onOpenRepo?.(comment.repo!);
      setTimeout(() => jumpTo(comment), 60);
      return;
    }
    jumpTo(comment);
  }
  const loc =
    comment.side === 'general' ? 'General' : comment.side === 'file' ? `${comment.file} · whole file` : `${comment.file}:${comment.line}`;
  // Resolved threads stay listed but are dimmed + checked (the user asked to
  // keep them visible in the left list, only collapsed in the diff).
  return (
    <li className={'wd-comments-panel-row' + (comment.resolved ? ' wd-comments-panel-row-resolved' : '')} onClick={onClick}>
      <div className="wd-comments-panel-loc">
        {comment.resolved && (
          <span className="wd-resolved-check" aria-hidden="true">
            ✓{' '}
          </span>
        )}
        {elsewhere && <span className="wd-comments-panel-repo">{comment.repo} · </span>}
        {loc}
      </div>
      <div className="wd-comments-panel-body">{comment.body.split('\n')[0]}</div>
    </li>
  );
}

/** Scroll to a comment's place in the diff on screen (the general pane, or its file and line). */
function jumpTo(comment: Comment) {
  if (comment.side === 'general') {
    const pane = document.querySelector('.wd-general-pane');
    const details = pane?.querySelector('details');
    if (details && !details.open) details.open = true;
    pane?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  // Find the table row corresponding to this comment's anchor.
  const file = document.querySelector<HTMLElement>(`article.wd-file[data-path="${cssEscape(comment.file)}"]`);
  if (!file) return;
  // Scroll into view and flash the first matching row.
  file.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Whole-file comments have no line to flash — the file scroll is enough.
  if (comment.side !== 'file') flashLine(file, comment.line, comment.side);
}

function flashLine(file: HTMLElement, line: number, side: 'left' | 'right' | 'general') {
  const cells = file.querySelectorAll<HTMLTableCellElement>(side === 'right' ? '.wd-ln-new' : '.wd-ln-old');
  for (const cell of cells) {
    if (cell.textContent?.trim() === String(line)) {
      const row = cell.closest('tr');
      if (row) {
        row.classList.add('wd-row-flash');
        setTimeout(() => row.classList.remove('wd-row-flash'), 1200);
        const next = row.nextElementSibling;
        if (next?.classList.contains('wd-comment-row')) {
          next.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
      break;
    }
  }
}

/** Minimal CSS.escape polyfill. */
function cssEscape(s: string): string {
  return s.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&');
}
