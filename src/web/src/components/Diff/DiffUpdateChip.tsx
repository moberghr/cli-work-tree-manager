interface Props {
  /** Files in the staged diff, when the caller can count them. */
  filesChanged?: number | null;
  /** Swap the staged diff in, in place — keeps the current scroll position. */
  onShow: () => void;
  /** Soft reload: refetch from the server and jump back to the top. */
  onReload: () => void;
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
 * Two actions on purpose. "Show" applies the payload we already fetched
 * without touching scroll — you carry on reading where you were. "Reload"
 * re-fetches from the server and jumps to the top: what a browser refresh
 * would give you, done in-place so the page (terminal, expanded context,
 * sidebar width, dashboard route) survives. Reading mid-file wants the
 * first; coming back after a long Claude run usually wants the second.
 */
export function DiffUpdateChip({ filesChanged, onShow, onReload }: Props) {
  const count =
    typeof filesChanged === 'number' && filesChanged > 0
      ? `${filesChanged} file${filesChanged === 1 ? '' : 's'}`
      : null;
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
      <button
        type="button"
        className="wd-diff-update-btn"
        onClick={onReload}
        title="Fetch the latest from the server and jump to the top"
      >
        Reload
      </button>
    </span>
  );
}
