/**
 * Thin indeterminate progress bar shown at the top of the diff pane while a
 * fetch is in flight. Lives outside the checkpoint strip so it surfaces even
 * when there's no strip (≤1 checkpoint, or the dashboard's session view) —
 * the strip's inline spinner only covers the range-chip case.
 */
export function DiffLoadingBar() {
  return (
    <div
      className="wd-diff-loading-bar"
      role="progressbar"
      aria-label="Loading diff"
    />
  );
}
