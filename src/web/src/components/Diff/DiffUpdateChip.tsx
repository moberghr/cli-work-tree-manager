interface Props {
  /** Files in the staged diff, when the caller can count them. */
  filesChanged?: number | null;
  /** Swap the staged diff in, in place — keeps the current scroll position. */
  onShow: () => void;
  /** Soft reload: refetch from the server and jump back to the top. */
  onReload: () => void;
  /** Show ONLY what arrived — a checkpoint range from where the diff on
   *  screen stood to the live tree. Omitted when no checkpoint baseline is
   *  known (no checkpoints yet), in which case the button is not rendered. */
  onShowNewOnly?: () => void;
}

/**
 * "Changes available" control, GitHub-style: shown when a background check
 * found a newer diff that we're deliberately NOT applying, so the diff never
 * moves under the reader's cursor.
 *
 * Lives in the header — never as a banner above the diff. A banner would
 * itself shift every line down the moment it appeared, which is exactly the
 * jump this whole feature exists to prevent. The header is fixed-height and
 * already sticky, so this appears and disappears without touching layout.
 *
 * Three actions, by what you want to end up looking at. "Show" applies the
 * payload we already fetched without touching scroll — the whole diff,
 * carry on reading where you were. "Only new" narrows the view to a
 * checkpoint range covering just what landed while you were reading, which
 * is the fastest way to see what Claude did without re-reading the rest.
 * "Reload" re-fetches and jumps to the top: what a browser refresh would
 * give you, done in-place so the page (terminal, expanded context, sidebar
 * width, dashboard route) survives.
 */
export function DiffUpdateChip({ filesChanged, onShow, onReload, onShowNewOnly }: Props) {
  const count = typeof filesChanged === 'number' && filesChanged > 0 ? `${filesChanged} file${filesChanged === 1 ? '' : 's'}` : null;
  return (
    <span className="wd-diff-update" role="status">
      <span className="wd-diff-update-dot" aria-hidden="true" />
      <span className="wd-diff-update-text">
        New changes
        {count && <span className="wd-web-muted"> · {count}</span>}
      </span>
      <button
        type="button"
        className="wd-diff-update-btn wd-diff-update-btn-primary"
        onClick={onShow}
        title="Load the new diff here, keeping your scroll position"
      >
        Show
      </button>
      {onShowNewOnly && (
        <button
          type="button"
          className="wd-diff-update-btn"
          onClick={onShowNewOnly}
          title="Show only what changed since the last checkpoint in the diff you are looking at"
        >
          Only new
        </button>
      )}
      <button type="button" className="wd-diff-update-btn" onClick={onReload} title="Fetch the latest from the server and jump to the top">
        Reload
      </button>
    </span>
  );
}
