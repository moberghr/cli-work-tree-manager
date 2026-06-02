import { useEffect, useState } from 'react';
import {
  createTask,
  deleteTask,
  fetchTasks,
  updateTask,
  type TaskItem,
} from '../../api/panes.js';
import { useSse } from '../../api/events.js';

interface Props {
  /** Called when the user picks a task to turn into a worktree —
   *  caller opens the new-worktree modal pre-filled with a `todo/<slug>`
   *  branch derived from the task text. */
  onPick: (task: TaskItem) => void;
}

/** Slugify task text into a branch-name-safe suffix. Mirrors what the
 *  TUI does — lowercase, replace non-alnum with `-`, trim/collapse. */
export function taskSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

export function TasksPane({ onPick }: Props) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  function refresh() {
    fetchTasks().then((r) => setTasks(r.tasks));
  }

  useEffect(refresh, []);
  useSse('/events', { events: { 'tasks-changed': refresh } });

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) {
      setAdding(false);
      return;
    }
    try {
      const r = await createTask(draft.trim());
      setTasks(r.tasks);
      setDraft('');
      setAdding(false);
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

  const visible = showDone ? tasks : tasks.filter((t) => !t.done);

  return (
    <details className="wd-web-group wd-web-pane" open>
      <summary className="wd-web-group-summary">
        <span className="wd-web-group-target">Tasks</span>
        <span className="wd-web-group-count">{visible.length}</span>
      </summary>
      <div className="wd-web-pane-toolbar">
        <button
          type="button"
          className="wd-web-link-btn"
          onClick={() => setAdding(true)}
        >
          + Add
        </button>
        <label className="wd-web-pane-toggle">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
          />
          show done
        </label>
      </div>
      {adding && (
        <form className="wd-web-task-add" onSubmit={submitAdd}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Task text"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraft('');
                setAdding(false);
              }
            }}
          />
          <button type="submit" className="wd-btn-primary">
            Add
          </button>
        </form>
      )}
      <ul className="wd-web-session-list">
        {visible.map((t) => (
          <li
            key={t.id}
            className={
              'wd-web-session-row' + (t.done ? ' wd-web-task-done' : '')
            }
          >
            <div className="wd-web-session-row-main">
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => toggle(t)}
                onClick={(e) => e.stopPropagation()}
              />
              <span
                className="wd-web-session-branch"
                onClick={() => toggle(t)}
                title={t.text}
              >
                {t.text}
              </span>
              <button
                type="button"
                className="wd-web-task-action"
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(t);
                }}
                title="Create worktree (todo/<slug>)"
              >
                w
              </button>
              <button
                type="button"
                className="wd-web-task-action"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(t.id);
                }}
                title="Delete task"
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
