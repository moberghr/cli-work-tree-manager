interface Props {
  /** 1-based. */
  position: number;
  total: number;
  onNext: () => void;
  onStop: () => void;
}

/** Above a session while you walk the review queue: where you are, and the
 *  way on. `n` does the same as Next. */
export function ReviewQueueBar({ position, total, onNext, onStop }: Props) {
  const last = position >= total;
  return (
    <div className="wd-review-queue-bar" role="status">
      <span className="wd-review-queue-title">Reviewing finished work</span>
      <span className="wd-review-queue-pos">
        {position} of {total}
      </span>
      <span className="wd-review-queue-hint">Showing what the last instruction changed</span>
      <span className="wd-review-queue-actions">
        <button type="button" className="wd-btn-primary wd-review-queue-next" onClick={onNext} title="Next in the queue (n)">
          {last ? 'Done' : 'Next'} <kbd>n</kbd>
        </button>
        <button type="button" className="wd-row-action" onClick={onStop} title="Leave the queue; stay on this session">
          Stop
        </button>
      </span>
    </div>
  );
}
