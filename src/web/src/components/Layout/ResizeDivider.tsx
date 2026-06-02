import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

const STORAGE_KEY = 'work-web:sidebar-width';
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 200;
const MAX_WIDTH = 720;
const CSS_VAR = '--sidebar-width';

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
  } catch { /* */ }
  return DEFAULT_WIDTH;
}

function clamp(px: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, px));
}

/**
 * Sidebar-width state. The width persists across reloads via localStorage,
 * but during a drag we DON'T update this state — that would re-render the
 * whole layout 60 times per second and make scrolling/diff rendering janky.
 * Instead, the divider mutates the CSS variable on the layout element
 * directly, and only commits to state when the user releases.
 */
export function useSidebarWidth(): {
  width: number;
  setWidth: (px: number) => void;
} {
  const [width, setWidthState] = useState<number>(() => readStoredWidth());
  const setWidth = useCallback((px: number) => {
    const c = clamp(px);
    setWidthState(c);
    try { localStorage.setItem(STORAGE_KEY, String(c)); } catch { /* */ }
  }, []);
  return { width, setWidth };
}

interface Props {
  /** Ref to the layout element that owns the `--sidebar-width` variable.
   *  We write directly to its style during the drag, no React in the loop. */
  layoutRef: RefObject<HTMLElement | null>;
  /** Initial width for the drag (the committed value). */
  width: number;
  /** Called once at pointer-up with the final clamped width. */
  onCommit: (px: number) => void;
}

/**
 * GitHub-style 4 px vertical drag handle. Updates the CSS variable
 * imperatively on every pointer-move so React doesn't reconcile until the
 * drag ends. Pointer-capture keeps the drag alive when the cursor leaves
 * the strip. Double-click resets to the default.
 */
export function ResizeDivider({ layoutRef, width, onCommit }: Props) {
  const startRef = useRef<{ x: number; w: number } | null>(null);
  const lastRef = useRef<number>(width);
  const [dragging, setDragging] = useState(false);

  function writeVar(px: number) {
    const c = clamp(px);
    lastRef.current = c;
    layoutRef.current?.style.setProperty(CSS_VAR, `${c}px`);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, w: width };
    lastRef.current = width;
    setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    writeVar(startRef.current.w + dx);
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
    document.body.style.cursor = 'col-resize';
    return () => {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging]);

  return (
    <div
      className={'wd-resize-divider' + (dragging ? ' wd-resize-dragging' : '')}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onCommit(DEFAULT_WIDTH)}
      title="Drag to resize, double-click to reset"
    />
  );
}
