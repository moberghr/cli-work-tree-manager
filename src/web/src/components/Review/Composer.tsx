import { useEffect, useRef, useState } from 'react';
import { selectHasDrafts, useReviewOptional } from '../../state/ReviewProvider.js';

interface Props {
  /** Header line shown above the textarea, e.g. "api/src/users.ts : line 42 (right)". */
  context?: string;
  placeholder?: string;
  /** Whether the secondary "draft" button shows. Reply composers omit it. */
  allowDraft?: boolean;
  /** If draft mode is allowed, this controls the label of the secondary button. */
  draftLabel?: string;
  /** Label for the primary publish button. */
  publishLabel?: string;
  onSubmit: (body: string, status: 'published' | 'draft') => void | Promise<void>;
  onCancel: () => void;
  autoFocus?: boolean;
}

export function Composer({
  context,
  placeholder = 'Leave a review comment…',
  allowDraft = true,
  draftLabel = 'Start review',
  publishLabel = 'Comment',
  onSubmit,
  onCancel,
  autoFocus = true,
}: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // Once a review has pending (draft) comments, the review has already begun —
  // GitHub collapses the two-button choice into a single "Add review comment".
  const review = useReviewOptional();
  const reviewStarted = review ? selectHasDrafts(review.comments) : false;
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  async function submit(status: 'published' | 'draft') {
    const text = value.trim();
    if (!text) {
      onCancel();
      return;
    }
    try {
      await onSubmit(text, status);
      setValue('');
    } catch {
      // Submission failed — keep the typed text so it isn't lost.
    }
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // When starting a review is an option, Ctrl+Enter defaults to it (batching)
      // rather than posting a single comment.
      submit(allowDraft ? 'draft' : 'published');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="wd-comment-form">
      {context && <div className="wd-comment-form-context">{context}</div>}
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="wd-comment-form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        {allowDraft ? (
          reviewStarted ? (
            // Review already in progress — a single action adds to it.
            <button
              type="button"
              className="wd-btn-primary"
              onClick={() => submit('draft')}
              disabled={!value.trim()}
            >
              Add review comment (Ctrl+Enter)
            </button>
          ) : (
            <>
              <button
                type="button"
                className="wd-btn-secondary"
                onClick={() => submit('published')}
                disabled={!value.trim()}
              >
                {publishLabel}
              </button>
              <button
                type="button"
                className="wd-btn-primary"
                onClick={() => submit('draft')}
                disabled={!value.trim()}
              >
                {draftLabel} (Ctrl+Enter)
              </button>
            </>
          )
        ) : (
          <button
            type="button"
            className="wd-btn-primary"
            onClick={() => submit('published')}
            disabled={!value.trim()}
          >
            {publishLabel} (Ctrl+Enter)
          </button>
        )}
      </div>
    </div>
  );
}
