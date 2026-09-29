import { useState } from 'react';
import { useRevertOptional } from '../../state/RevertProvider.js';

interface Props {
  repo: string;
  path: string;
  /** New-side line range of a hunk; omitted = the whole file. */
  lines?: { start: number; end: number };
}

/** "Revert" on a file or hunk header: confirm, undo back to HEAD, and the
 *  server leaves Claude a note so it doesn't put the change back. */
export function RevertButton({ repo, path, lines }: Props) {
  const api = useRevertOptional();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!api) return null;
  const what = lines ? `lines ${lines.start}–${lines.end} of ${path}` : path;
  return (
    <span className="wd-revert">
      <button
        type="button"
        className="wd-revert-btn"
        disabled={busy}
        aria-label={lines ? `Revert hunk: ${path} lines ${lines.start}–${lines.end}` : `Revert file: ${path}`}
        title={`Undo the uncommitted change to ${what} and tell Claude`}
        onClick={async (e) => {
          e.stopPropagation();
          if (!confirm(`Revert ${what} back to HEAD?

This discards the uncommitted change; Claude is told not to reintroduce it.`)) return;
          setBusy(true);
          setError(null);
          try {
            await api.revert(repo, path, lines);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Reverting…' : lines ? '↶ Revert' : '↶ Revert file'}
      </button>
      {error && (
        <span className="wd-revert-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
