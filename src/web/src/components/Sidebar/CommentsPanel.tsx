import { useReview } from '../../state/ReviewProvider.js';
import type { Comment } from '../../api/client.js';

interface Props {
  /** Which repo we're showing. General comments are included regardless. */
  repoName: string;
}

export function CommentsPanel({ repoName }: Props) {
  const review = useReview();
  // Show top-level comments only (replies render under their parents inline).
  const entries = review.comments.filter((c) => {
    if (c.parentId) return false;
    if (c.side === 'general') return true;
    return c.repo === repoName;
  });

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
            <CommentsPanelRow key={c.id} comment={c} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CommentsPanelRow({ comment }: { comment: Comment }) {
  function onClick() {
    if (comment.side === 'general') {
      const pane = document.querySelector('.wd-general-pane');
      const details = pane?.querySelector('details');
      if (details && !details.open) details.open = true;
      pane?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // Find the table row corresponding to this comment's anchor.
    const file = document.querySelector<HTMLElement>(
      `article.wd-file[data-path="${cssEscape(comment.file)}"]`,
    );
    if (!file) return;
    // Scroll into view and flash the first matching row.
    file.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flashLine(file, comment.line, comment.side);
  }
  return (
    <li className="wd-comments-panel-row" onClick={onClick}>
      <div className="wd-comments-panel-loc">
        {comment.side === 'general' ? 'General' : `${comment.file}:${comment.line}`}
      </div>
      <div className="wd-comments-panel-body">{comment.body.split('\n')[0]}</div>
    </li>
  );
}

function flashLine(file: HTMLElement, line: number, side: 'left' | 'right' | 'general') {
  const cells = file.querySelectorAll<HTMLTableCellElement>(
    side === 'right' ? '.wd-ln-new' : '.wd-ln-old',
  );
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
