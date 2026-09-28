import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

/**
 * Describes one resizable dimension: which CSS variable it drives, where
 * it persists, its bounds, and which way the handle drags.
 */
export interface ResizeSpec {
  storageKey: string;
  cssVar: string;
  defaultPx: number;
  min: number;
  max: number;
  /** 'x' = vertical handle resizing a width; 'y' = horizontal handle
   *  resizing a height. */
  axis: 'x' | 'y';
  /** True when the resized element sits AFTER the handle (right of / below
   *  it), so dragging towards it shrinks it. */
  invert?: boolean;
  label: string;
}

/** Diff/review file-tree sidebar (left of the handle). */
export const SIDEBAR_SPEC: ResizeSpec = {
  storageKey: 'work-web:sidebar-width',
  cssVar: '--sidebar-width',
  defaultPx: 320,
  min: 200,
  max: 720,
  axis: 'x',
  label: 'Resize sidebar',
};

/** `work web` dashboard session rail. */
export const RAIL_SPEC: ResizeSpec = {
  storageKey: 'work-web:rail-width',
  cssVar: '--rail-width',
  // Rows are two lines with diff size, PR and status — 160 px truncated
  // every branch name.
  defaultPx: 248,
  min: 160,
  max: 480,
  axis: 'x',
  label: 'Resize session list',
};

/** Comments panel height at the bottom of the diff sidebar (below the
 *  handle, hence `invert`). */
export const COMMENTS_SPEC: ResizeSpec = {
  storageKey: 'work-web:comments-height',
  cssVar: '--comments-height',
  defaultPx: 220,
  min: 60,
  max: 900,
  axis: 'y',
  invert: true,
  label: 'Resize comments panel',
};

function clamp(spec: ResizeSpec, px: number): number {
  return Math.max(spec.min, Math.min(spec.max, px));
}

function readStored(spec: ResizeSpec): number {
  try {
    const raw = localStorage.getItem(spec.storageKey);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= spec.min && n <= spec.max) return n;
  } catch { /* */ }
  return spec.defaultPx;
}

/**
 * Persisted size state for one ResizeSpec. During a drag we DON'T update
 * this state — that would re-render the whole layout 60 times per second
 * and make scrolling/diff rendering janky. Instead, the divider mutates the
 * CSS variable on the layout element directly, and only commits to state
 * when the user releases.
 */
export function useResizableSize(spec: ResizeSpec): {
  size: number;
  setSize: (px: number) => void;
} {
  const [size, setSizeState] = useState<number>(() => readStored(spec));
  const setSize = useCallback(
    (px: number) => {
      const c = clamp(spec, px);
      setSizeState(c);
      try { localStorage.setItem(spec.storageKey, String(c)); } catch { /* */ }
    },
    [spec],
  );
  return { size, setSize };
}

/** Sidebar-width state (the original, most common use). */
export function useSidebarWidth(): {
  width: number;
  setWidth: (px: number) => void;
} {
  const { size, setSize } = useResizableSize(SIDEBAR_SPEC);
  return { width: size, setWidth: setSize };
}

interface Props {
  /** Ref to the layout element that owns the spec's CSS variable. We write
   *  directly to its style during the drag, no React in the loop. */
  layoutRef: RefObject<HTMLElement | null>;
  /** Initial size for the drag (the committed value). */
  size: number;
  /** Called once at pointer-up with the final clamped size. */
  onCommit: (px: number) => void;
  /** Which dimension this handle drives. Defaults to the diff sidebar. */
  spec?: ResizeSpec;
}

/**
 * GitHub-style 4 px drag handle (vertical for widths, horizontal for
 * heights). Updates the CSS variable imperatively on every pointer-move so
 * React doesn't reconcile until the drag ends. Pointer-capture keeps the
 * drag alive when the cursor leaves the strip. Double-click resets to the
 * default.
 */
export function ResizeDivider({
  layoutRef,
  size,
  onCommit,
  spec = SIDEBAR_SPEC,
}: Props) {
  const startRef = useRef<{ pos: number; w: number } | null>(null);
  const lastRef = useRef<number>(size);
  const [dragging, setDragging] = useState(false);

  function writeVar(px: number) {
    const c = clamp(spec, px);
    lastRef.current = c;
    layoutRef.current?.style.setProperty(spec.cssVar, `${c}px`);
  }

  const pointerPos = (e: React.PointerEvent<HTMLDivElement>) =>
    spec.axis === 'x' ? e.clientX : e.clientY;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startRef.current = { pos: pointerPos(e), w: size };
    lastRef.current = size;
    setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!startRef.current) return;
    const delta = pointerPos(e) - startRef.current.pos;
    writeVar(startRef.current.w + (spec.invert ? -delta : delta));
  }
  function onPointerUp() {
    if (!startRef.current) return;
    startRef.current = null;
    setDragging(false);
    onCommit(lastRef.current);
  }

  // Suppress text-selection / link drags / iframe events while resizing.
  useEffect(() => {
    if (!dragging) return;
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = spec.axis === 'x' ? 'col-resize' : 'row-resize';
    return () => {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging, spec.axis]);

  return (
    <div
      className={
        'wd-resize-divider' +
        (spec.axis === 'y' ? ' wd-resize-divider-y' : '') +
        (dragging ? ' wd-resize-dragging' : '')
      }
      role="separator"
      aria-orientation={spec.axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={spec.label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onCommit(spec.defaultPx)}
      title="Drag to resize, double-click to reset"
    />
  );
}
