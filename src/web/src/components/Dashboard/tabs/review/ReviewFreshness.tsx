import { useEffect, useRef, useState } from 'react';
import { reviewFreshness, type FreshnessInput } from '../../../../state/review-view.js';

/** How often the "started 2 min ago" line is redrawn while a review is being prepared. */
const TICK_MS = 15_000;
/** How long "New review ready" stays after one lands while you watch. */
const JUST_READY_MS = 20_000;

/**
 * Where a review stands, above it (reported: after Prepare again nothing said whether it was running, done, or
 * still the old one): being prepared — since when, and that what is below is the previous one, from when — or
 * its preparing failed with the previous one kept, or, once ready, when it was prepared; and "New review ready"
 * for a while when one lands while the page is open.
 */
export function ReviewFreshness(props: FreshnessInput) {
  const [now, setNow] = useState(() => Date.now());
  const preparing = props.status === 'running';
  useEffect(() => {
    if (!preparing) return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [preparing]);

  // Landed while you watched: it was being prepared, and now it's ready.
  const was = useRef(props.status);
  const [justReady, setJustReady] = useState(false);
  useEffect(() => {
    const before = was.current;
    was.current = props.status;
    if (before === 'running' && props.status === 'ready') {
      setJustReady(true);
      const t = setTimeout(() => setJustReady(false), JUST_READY_MS);
      return () => clearTimeout(t);
    }
  }, [props.status]);

  const f = reviewFreshness(props, preparing ? now : Date.now());
  if (!f) return null;
  if (f.kind === 'ready') {
    return justReady ? (
      <p className="wd-review-freshness wd-review-freshness-new" role="status">
        New review ready · {f.text}
      </p>
    ) : (
      <p className="wd-start-note wd-review-freshness-when">{f.text}</p>
    );
  }
  return (
    <p className={`wd-review-freshness wd-review-freshness-${f.kind}`} role="status">
      {f.kind === 'preparing' && <span className="wd-review-freshness-spinner" aria-hidden="true" />}
      {f.text}
    </p>
  );
}
