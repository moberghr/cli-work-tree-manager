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

  const itemClasses = [
    'wd-comment',
    `wd-author-${comment.author}`,
    isReply ? 'wd-comment-reply' : '',
    comment.status === 'draft' ? 'wd-status-draft' : '',
    outdated ? 'wd-comment-outdated' : '',
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
