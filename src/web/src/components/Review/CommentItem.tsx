import { useState } from 'react';
import { useReview, selectReplies } from '../../state/ReviewProvider.js';
import type { Comment } from '../../api/client.js';
import { Markdown } from '../Markdown.js';
import { Composer } from './Composer.js';

interface Props {
  comment: Comment;
  /** Current text of the line the parent comment is anchored to, if any.
   *  When the comment's stored `lineContent` differs, we mark it outdated. */
  currentLineContent?: string | null;
}

export function CommentItem({ comment, currentLineContent }: Props) {
  const review = useReview();
  const outdated =
    comment.lineContent !== undefined &&
    currentLineContent !== null &&
    currentLineContent !== undefined &&
    comment.lineContent !== currentLineContent;
  const isReply = !!comment.parentId;
  const replies = selectReplies(review.comments, comment.id);

  // The reply target is always the top-level comment (replies-to-replies
  // join the same flat thread). Whoever owns the top-level id is who we
  // pass to the API as parentId.
  const replyParentId = comment.parentId ?? comment.id;
  const replyOpen = review.openReplyTo === replyParentId && comment.id === replyParentId;

  // Resolve/collapse only applies to a top-level thread. A resolved thread
  // collapses to a one-line bar in the diff; clicking it re-expands locally
  // (without un-resolving). Replies inherit the parent's collapse.
  const isResolved = !isReply && !!comment.resolved;
  const [expandedResolved, setExpandedResolved] = useState(false);
  if (isResolved && !expandedResolved) {
    const firstLine = comment.body.split('\n')[0];
    return (
      <button
        type="button"
        className="wd-comment-resolved-bar"
        onClick={() => setExpandedResolved(true)}
        title="Resolved — click to show"
      >
        <span className="wd-resolved-check" aria-hidden="true">
          ✓
        </span>
        <span className="wd-resolved-summary">{firstLine}</span>
        {replies.length > 0 && (
          <span className="wd-resolved-replies">
            · {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </span>
        )}
        <span className="wd-resolved-show">Show</span>
      </button>
    );
  }

  const itemClasses = [
    'wd-comment',
    `wd-author-${comment.author}`,
    isReply ? 'wd-comment-reply' : '',
    comment.status === 'draft' ? 'wd-status-draft' : '',
    outdated ? 'wd-comment-outdated' : '',
    isResolved ? 'wd-comment-resolved' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <div className={itemClasses}>
        {comment.status === 'draft' && (
          <div className="wd-draft-badge">PENDING</div>
        )}
        {outdated && (
          <div className="wd-comment-outdated-badge">
            outdated — line has changed since this comment was written
          </div>
        )}
        {comment.author === 'claude' && (
          <div className="wd-comment-author">Claude</div>
        )}
        <div className="wd-comment-body">
          <Markdown source={comment.body} />
        </div>
        <div className="wd-comment-actions">
          <button
            type="button"
            className="wd-comment-action-link"
            onClick={() => review.openReplyAt(replyParentId)}
          >
            reply
          </button>
          {!isReply && (
            <button
              type="button"
              className="wd-comment-action-link"
              onClick={() => {
                // Re-resolving collapses again next render; clear the local
                // expand so an already-resolved-then-expanded thread folds.
                setExpandedResolved(false);
                review.resolveComment(comment.id, !comment.resolved);
              }}
            >
              {comment.resolved ? 'unresolve' : 'resolve'}
            </button>
          )}
          {isResolved && expandedResolved && (
            <button
              type="button"
              className="wd-comment-action-link"
              onClick={() => setExpandedResolved(false)}
            >
              collapse
            </button>
          )}
          <button
            type="button"
            className="wd-comment-delete"
            onClick={() => review.deleteComment(comment.id)}
          >
            delete
          </button>
        </div>
      </div>

      {/* Render replies under the top-level item. */}
      {!isReply &&
        replies.map((r) => (
          <CommentItem
            key={r.id}
            comment={r}
            currentLineContent={currentLineContent}
          />
        ))}

      {/* Render reply composer under the top-level item. */}
      {!isReply && replyOpen && (
        <Composer
          allowDraft={false}
          publishLabel="Reply"
          placeholder="Reply…"
          onSubmit={async (body, _status) => {
            await review.postComment({
              parentId: replyParentId,
              body,
            });
            review.closeReply();
          }}
          onCancel={() => review.closeReply()}
        />
      )}
    </>
  );
}
