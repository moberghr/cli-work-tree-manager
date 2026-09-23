interface Props {
  /** What the wait is: "loading…" for a fetch the user asked for,
   *  "checking…" for a background look at what changed on disk. */
  label: string;
}

/**
 * The only in-flight indicator the diff views have. It lives in the header
 * because every alternative moves the page: dimming the diff, or slotting a
 * progress bar above it, changes what the reader is looking at mid-scroll —
 * which is the thing staged reloads exist to prevent. Tiny and
 * layout-neutral: the header is fixed-height, so this appears and disappears
 * without shifting a single row.
 */
export function DiffBusyChip({ label }: Props) {
  return (
    <span className="wd-diff-checking" role="status">
      <span className="wd-diff-checking-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
