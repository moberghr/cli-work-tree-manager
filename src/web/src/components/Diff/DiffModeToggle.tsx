import { useDiffModeControls } from '../../state/DiffModeProvider.js';

/**
 * Split | Unified segmented toggle, GitHub's "Split / Unified" control.
 * Reads and writes the global, persisted diff-mode preference. Renders
 * nothing when no DiffModeProvider is mounted (defensive — every real view
 * mounts one at the app root).
 */
export function DiffModeToggle() {
  const ctrl = useDiffModeControls();
  if (!ctrl) return null;
  const { mode, setMode } = ctrl;
  return (
    <div className="wd-diff-mode" role="group" aria-label="Diff layout">
      <button
        type="button"
        aria-pressed={mode === 'split'}
        className={
          'wd-diff-mode-btn' + (mode === 'split' ? ' wd-diff-mode-btn-active' : '')
        }
        onClick={() => setMode('split')}
        title="Side-by-side layout"
      >
        Split
      </button>
      <button
        type="button"
        aria-pressed={mode === 'unified'}
        className={
          'wd-diff-mode-btn' + (mode === 'unified' ? ' wd-diff-mode-btn-active' : '')
        }
        onClick={() => setMode('unified')}
        title="Unified (inline) layout"
      >
        Unified
      </button>
    </div>
  );
}
