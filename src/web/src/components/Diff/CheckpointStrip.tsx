import type {
  CheckpointEntry,
  CheckpointRangeEnd,
} from '../../api/client.js';

interface Props {
  entries: CheckpointEntry[];
  /** Currently selected "from" — always a checkpoint id (numeric). */
  fromId: number;
  /** Currently selected "to" — checkpoint id or `'working'` for the
   *  rightmost (live) chip. */
  toId: CheckpointRangeEnd;
  /** Plain click semantic: set `from = 0` (Initial), `to = chip-id`. */
  onSelect: (toId: CheckpointRangeEnd) => void;
  /** Shift-click: extend the existing range — keep `from`, replace `to`,
   *  or vice-versa depending on which side of the current range the
   *  click landed. The component is dumb; the caller decides. */
  onExtend: (toId: CheckpointRangeEnd) => void;
}

/**
 * Top strip of checkpoint chips. Renders Initial · #1 · #2 · ... · Working.
 * Chip styling reflects role: from / to / in-range / outside-range.
 *
 * Hidden by the parent until at least one non-initial checkpoint exists
 * (otherwise there's no range to choose between).
 */
export function CheckpointStrip({
  entries,
  fromId,
  toId,
  onSelect,
  onExtend,
}: Props) {
  if (entries.length === 0) return null;

  const handleClick = (
    e: React.MouseEvent,
    end: CheckpointRangeEnd,
  ) => {
    if (e.shiftKey) {
      onExtend(end);
    } else {
      onSelect(end);
    }
  };

  const toNumeric = toId === 'working' ? Number.POSITIVE_INFINITY : toId;
  const inRange = (id: number) => id >= fromId && id <= toNumeric;

  return (
    <nav
      className="wd-checkpoint-strip"
      role="tablist"
      aria-label="Checkpoint range"
    >
      <span
        className="wd-checkpoint-label"
        title="Click a chip to set the right endpoint · Shift+click to set the left endpoint"
      >
        Range:
      </span>
      {entries.map((e) => {
        const isFrom = e.id === fromId;
        const isTo = toId !== 'working' && e.id === toId;
        const cls =
          'wd-checkpoint-chip' +
          (isFrom ? ' wd-checkpoint-chip-from' : '') +
          (isTo ? ' wd-checkpoint-chip-to' : '') +
          (!isFrom && !isTo && inRange(e.id)
            ? ' wd-checkpoint-chip-in-range'
            : '');
        const display =
          e.label && e.label.trim().length > 0 ? e.label : `#${e.id}`;
        const ts = new Date(e.ts);
        const title = `${display} — ${ts.toLocaleString()}\nClick: set the right endpoint here\nShift+click: set the left endpoint here`;
        return (
          <button
            key={e.id}
            type="button"
            className={cls}
            title={title}
            onClick={(ev) => handleClick(ev, e.id)}
          >
            {display}
          </button>
        );
      })}
      <button
        type="button"
        className={
          'wd-checkpoint-chip wd-checkpoint-chip-working' +
          (toId === 'working' ? ' wd-checkpoint-chip-to' : '')
        }
        title="Working tree (live)"
        onClick={(ev) => handleClick(ev, 'working')}
      >
        Working
      </button>
    </nav>
  );
}
