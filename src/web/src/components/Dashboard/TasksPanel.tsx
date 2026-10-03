import { useEffect, useRef } from 'react';
import type { TaskItem } from '../../api/panes.js';
import { TasksTab } from './tabs/TasksTab.js';

/**
 * "Tasks" in the top bar: your to-do list (`work todo`) in a small panel
 * under it, rather than a page of its own. Picking a task starts a
 * worktree for it. Esc or a click elsewhere closes it; `g t` toggles it.
 */
export function TasksPanel({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (task: TaskItem) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const changeRef = useRef(onOpenChange);
  changeRef.current = onOpenChange;
  useEffect(() => {
    if (!open) return;
    const close = () => changeRef.current(false);
    const onKey = (e: KeyboardEvent) => {
      // A row's own menu or an edit field takes Escape first.
      if (e.key === 'Escape' && !document.querySelector('.wd-row-menu') && !(e.target as HTMLElement).closest?.('input')) close();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || (t as HTMLElement).closest?.('.wd-row-menu')) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  return (
    <div className="wd-tasks-popover" ref={ref}>
      <button
        type="button"
        className={'wd-topnav-btn' + (open ? ' wd-topnav-btn-on' : '')}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Your tasks (g t)"
        onClick={() => onOpenChange(!open)}
      >
        Tasks
      </button>
      {open && (
        <div className="wd-tasks-panel" role="dialog" aria-label="Tasks">
          <TasksTab
            onPick={(t) => {
              onOpenChange(false);
              onPick(t);
            }}
          />
        </div>
      )}
    </div>
  );
}
