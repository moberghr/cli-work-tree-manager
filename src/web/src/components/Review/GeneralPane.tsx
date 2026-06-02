import { useState } from 'react';
import { useReview } from '../../state/ReviewProvider.js';
import { CommentItem } from './CommentItem.js';

/**
 * Collapsible "General review note" pane at the top of the review view.
 * Hosts a composer for non-line-anchored comments and lists the resulting
 * general thread (with replies).
 */
export function GeneralPane() {
  const review = useReview();
  const [text, setText] = useState('');

  const general = review.comments.filter(
    (c) => c.side === 'general' && !c.parentId,
  );

  async function submit(status: 'published' | 'draft') {
    const body = text.trim();
    if (!body) return;
    await review.postComment({ side: 'general', body, status });
    setText('');
  }

  return (
    <section className="wd-general-pane">
      <details>
        <summary>General review note (not tied to any line)</summary>
        <textarea
          className="wd-general-input"
          placeholder="A high-level comment for Claude…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit('published');
            }
          }}
        />
        <div className="wd-general-pane-actions">
          <button
            type="button"
            className="wd-btn-secondary"
            disabled={!text.trim()}
            onClick={() => submit('draft')}
          >
            {review.comments.some((c) => c.status === 'draft')
              ? 'Add to review'
              : 'Start review'}
          </button>
          <button
            type="button"
            className="wd-btn-primary"
            disabled={!text.trim()}
            onClick={() => submit('published')}
          >
            Comment (Ctrl+Enter)
          </button>
        </div>
        {general.length > 0 && (
          <div className="wd-general-pane-list">
            {general.map((g) => (
              <CommentItem key={g.id} comment={g} currentLineContent={null} />
            ))}
          </div>
        )}
      </details>
    </section>
  );
}
