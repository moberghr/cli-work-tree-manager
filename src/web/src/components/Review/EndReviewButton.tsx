import { useState } from 'react';
import {
  selectDrafts,
  selectPublishedCount,
  useReview,
} from '../../state/ReviewProvider.js';
import { Modal } from './Modal.js';

export function EndReviewButton() {
  const review = useReview();
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'submitting' | 'ending'>('idle');
  const draftCount = selectDrafts(review.comments).length;
  const publishedCount = selectPublishedCount(review.comments);

  return (
    <>
      <button
        type="button"
        className="wd-done-bar"
        onClick={() => setModalOpen(true)}
        disabled={busy !== 'idle'}
      >
        {busy === 'idle' ? 'End review ' : busy === 'submitting' ? 'Submitting… ' : 'Closing… '}
        <span className="wd-done-count">{publishedCount}</span>
      </button>
      {modalOpen && (
        <Modal
          title="End review?"
          onClose={() => setModalOpen(false)}
          actions={
            <>
              <button type="button" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
              {draftCount > 0 && (
                <button
                  type="button"
                  onClick={async () => {
                    setBusy('submitting');
                    try {
                      await review.submitReview('');
                      setBusy('ending');
                      await review.done();
                    } catch {
                      // Reset so the button isn't stuck; keep the modal open
                      // so the user can retry.
                      setBusy('idle');
                    }
                  }}
                >
                  Submit pending then end
                </button>
              )}
              <button
                type="button"
                className="wd-btn-primary"
                onClick={async () => {
                  setBusy('ending');
                  try {
                    await review.done();
                  } catch {
                    setBusy('idle');
                  }
                }}
              >
                {draftCount > 0 ? 'End anyway (discard drafts)' : 'End review'}
              </button>
            </>
          }
        >
          {draftCount > 0 ? (
            <>
              <p>
                <strong style={{ color: 'var(--status-modified-fg)' }}>
                  You have {draftCount} pending comment
                  {draftCount === 1 ? '' : 's'}.
                </strong>{' '}
                They have not been sent yet and will be lost if you end the review now.
              </p>
              {publishedCount > 0 && (
                <p style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {publishedCount} comment{publishedCount === 1 ? ' was' : 's were'}{' '}
                  already delivered.
                </p>
              )}
            </>
          ) : publishedCount === 0 ? (
            <p>
              You have left no comments. Closing the session will exit wd with no
              further action.
            </p>
          ) : (
            <p>
              Your {publishedCount} comment{publishedCount === 1 ? '' : 's'}{' '}
              {publishedCount === 1 ? 'has' : 'have'} already been delivered.
              Closing the session will exit wd. You can then close the tab.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
