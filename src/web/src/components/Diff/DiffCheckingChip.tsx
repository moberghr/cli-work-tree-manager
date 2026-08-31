/**
 * Quiet header indicator: a background check for new changes is in flight.
 * Deliberately tiny and layout-neutral — the point of staged reloads is that
 * nothing in the diff moves, so the only signal is here in the header.
 */
export function DiffCheckingChip() {
  return (
    <span
      className="wd-diff-checking"
      role="status"
      title="Checking for new changes on disk"
    >
      <span className="wd-diff-checking-dot" aria-hidden="true" />
      checking…
    </span>
  );
}
