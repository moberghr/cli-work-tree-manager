import { useEffect, useRef, useState } from 'react';

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
      submit('published');
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
        {allowDraft && (
          <button
            type="button"
            className="wd-btn-secondary"
            onClick={() => submit('draft')}
            disabled={!value.trim()}
          >
            {draftLabel}
          </button>
        )}
        <button
          type="button"
          className="wd-btn-primary"
          onClick={() => submit('published')}
          disabled={!value.trim()}
        >
          {publishLabel} (Ctrl+Enter)
        </button>
      </div>
    </div>
  );
}
