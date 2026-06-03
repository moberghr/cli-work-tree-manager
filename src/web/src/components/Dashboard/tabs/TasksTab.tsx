import { useEffect, useMemo, useState } from 'react';
import {
  createTask,
  deleteTask,
  fetchTasks,
  updateTask,
  type TaskItem,
} from '../../../api/panes.js';
import { useSse } from '../../../api/events.js';

interface Props {
  onPick: (task: TaskItem) => void;
}

/** Slugify task text into a branch-name-safe suffix. */
export function taskSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

/** Full-width Tasks tab: a flat list with quick add + per-row actions. */
export function TasksTab({ onPick }: Props) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState('');

  function refresh() {
    fetchTasks().then((r) => setTasks(r.tasks));
  }

  useEffect(refresh, []);
  useSse('/events', { events: { 'tasks-changed': refresh } });

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    try {
      const r = await createTask(text);
      setTasks(r.tasks);
      setDraft('');
    } catch { /* */ }
  }

  async function toggle(t: TaskItem) {
    try {
      const r = await updateTask(t.id, { done: !t.done });
      setTasks(r.tasks);
    } catch { /* */ }
  }

  async function remove(id: number) {
    try {
      const r = await deleteTask(id);
      setTasks(r.tasks);
    } catch { /* */ }
  }

  const visible = useMemo(
    () => (showDone ? tasks : tasks.filter((t) => !t.done)),
    [tasks, showDone],
  );
  const counts = useMemo(() => {
    const open = tasks.filter((t) => !t.done).length;
    return { open, done: tasks.length - open };
  }, [tasks]);

  return (
    <div className="wd-dash-tab-pane wd-tab-tasks">
      <header className="wd-tab-header">
        <h1>
          Tasks{' '}
          <span className="wd-tab-header-muted">
            ({counts.open} open · {counts.done} done)
          </span>
        </h1>
        <div className="wd-tab-controls">
          <label>
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => setShowDone(e.target.checked)}
            />
            {' '}
            show done
          </label>
          <form className="wd-task-add" onSubmit={submitAdd}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="+ Add task…"
            />
            <button
              type="submit"
              className="wd-btn-primary"
              disabled={!draft.trim()}
            >
              Add
            </button>
          </form>
        </div>
      </header>
      {visible.length === 0 ? (
        <div className="wd-tab-empty">
          {tasks.length === 0
            ? 'No tasks yet. Add one above, or `work todo add <text>` from a terminal.'
            : 'No open tasks — toggle "show done" to see completed ones.'}
        </div>
      ) : (
        <ul className="wd-task-list">
          {visible.map((t) => (
            <li
              key={t.id}
              className={'wd-task-row' + (t.done ? ' wd-task-row-done' : '')}
            >
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => toggle(t)}
                aria-label={t.done ? 'Mark not done' : 'Mark done'}
              />
              <span
                className="wd-task-text"
                onClick={() => toggle(t)}
                title={t.text}
              >
                {t.text}
              </span>
              <button
                type="button"
                className="wd-btn-secondary wd-task-action"
                onClick={() => onPick(t)}
                title="Create worktree (todo/<slug>)"
              >
                → worktree
              </button>
              <button
                type="button"
                className="wd-task-action wd-task-remove"
                onClick={() => remove(t.id)}
                title="Delete task"
                aria-label="Delete task"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
