/** The bar's line from what each panel says waits on you; null when nothing does. Pure. */
export function needsYouText(parts: (string | null | undefined)[]): string | null {
  const shown = parts.filter((p): p is string => !!p);
  return shown.length ? shown.join(' · ') : null;
}

/**
 * "Needs you: 1 reply to post · CI failing on #212 [Review]" under the
 * session's status line: one line for what waits on you on GitHub. Review
 * unfolds the panels (reply drafts, CI) below it; Hide folds them again.
 */
export function NeedsYouBar({ text, open, onToggle }: { text: string; open: boolean; onToggle: () => void }) {
  return (
    <div className="wd-needs-you" role="status">
      <span className="wd-needs-you-label">Needs you</span>
      <span className="wd-needs-you-text">{text}</span>
      <button type="button" className="wd-btn-secondary wd-needs-you-btn" aria-expanded={open} onClick={onToggle}>
        {open ? 'Hide' : 'Review'}
      </button>
    </div>
  );
}
