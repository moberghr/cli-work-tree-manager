import { RAIL_COLOR_LABEL, type RailColor } from '../../../../core/rail/rail-layout.js';
import { tagClass } from '../../state/rail-menu.js';

/**
 * A session's color as a small square before its name, where a row has room
 * (the Sessions table, Ctrl+P, the Inbox); the rail shows a bar down the
 * row's edge instead. Named for screen readers and on hover.
 */
export function ColorMark({ color }: { color: RailColor | undefined }) {
  if (!color) return null;
  const label = RAIL_COLOR_LABEL[color];
  return <span className={`wd-color-mark ${tagClass(color)}`} role="img" aria-label={label} title={label} />;
}
