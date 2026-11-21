import { useDiffModeControls } from '../../state/DiffModeProvider.js';
import { Segmented } from '../../ui/index.js';

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
    <Segmented
      className="wd-diff-mode"
      label="Diff layout"
      value={mode}
      onChange={setMode}
      options={[
        { value: 'split', label: 'Split', title: 'Side-by-side layout', className: 'wd-diff-mode-btn' },
        { value: 'unified', label: 'Unified', title: 'Unified (inline) layout', className: 'wd-diff-mode-btn' },
      ]}
    />
  );
}
