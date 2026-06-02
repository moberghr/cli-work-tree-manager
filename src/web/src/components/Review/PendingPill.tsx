import { useState } from 'react';
import {
  selectDrafts,
  useReview,
} from '../../state/ReviewProvider.js';
import { Modal } from './Modal.js';

export function PendingPill() {
  const review = useReview();
  const [modalOpen, setModalOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const drafts = selectDrafts(review.comments);
  if (drafts.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="wd-pending-pill wd-visible"
        onClick={() => {
          setSummary('');
          setModalOpen(true);
        }}
      >
        Pending review <span className="wd-pending-count">({drafts.length})</span>
      </button>
      {modalOpen && (
        <Modal
          title="Submit your review"
          onClose={() => setModalOpen(false)}
          actions={
            <>
              <button
                type="button"
                onClick={async () => {
                  if (!confirm(`Discard all ${drafts.length} pending comment(s)?`)) return;
                  await review.discardReview();
                  setModalOpen(false);
                }}
              >
                Discard drafts
              </button>
              <button type="button" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="wd-btn-primary"
                onClick={async () => {
                  try {
                    await review.submitReview(summary);
                    setModalOpen(false);
                  } catch {
                    // Keep the modal open so the user can retry; their
                    // summary and drafts are preserved.
                  }
                }}
              >
                Submit review
              </button>
            </>
          }
        >
          <p>
            Sending {drafts.length} pending comment{drafts.length === 1 ? '' : 's'}.
            Add a summary if you like, then click Submit to send everything to Claude.
          </p>
          <textarea
            className="wd-submit-summary"
            placeholder="Optional summary…"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Modal>
      )}
    </>
  );
}
