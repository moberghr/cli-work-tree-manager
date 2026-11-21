import { useState } from 'react';
import { selectDrafts, useReview } from '../../state/ReviewProvider.js';
import { Modal } from './Modal.js';
import { ask } from '../../state/ask.js';
import { Button, TextArea } from '../../ui/index.js';

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
              <Button
                onClick={async () => {
                  if (!(await ask(`Discard all ${drafts.length} pending comment(s)?`, { ok: 'Discard', danger: true }))) return;
                  await review.discardReview();
                  setModalOpen(false);
                }}
              >
                Discard drafts
              </Button>
              <Button onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
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
              </Button>
            </>
          }
        >
          <p>
            Sending {drafts.length} pending comment{drafts.length === 1 ? '' : 's'}. Add a summary if you like, then click Submit to send
            everything to Claude.
          </p>
          <TextArea
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
