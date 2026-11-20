import type { ReviewDroppedWire } from '../../../../../../core/api-types.js';

/** Drafts set aside (not on a line of the diff, or dropped by a new push): their text, kept until you forget them. */
export function DroppedDrafts({ dropped, onClear }: { dropped: ReviewDroppedWire[]; onClear: () => void }) {
  return (
    <details className="wd-review-dropped">
      <summary className="wd-review-warn">
        {dropped.length} comment{dropped.length === 1 ? '' : 's'} set aside: not on a line of the diff
      </summary>
      <ul>
        {dropped.map((d, i) => (
          <li key={`${d.path}:${d.line}:${i}`}>
            <span className="wd-start-note">
              {d.path}:{d.line} · {d.by === 'you' ? 'yours' : 'AI'} · {d.why}
            </span>
            <div>{d.body}</div>
          </li>
        ))}
      </ul>
      <button type="button" className="wd-link-button" onClick={onClear}>
        Forget them
      </button>
    </details>
  );
}
