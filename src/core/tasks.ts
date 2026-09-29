import { json, tx, withDb, type Db } from './db.js';

export interface Task {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
  /** Optional link to a worktree session (target:branch). */
  link?: string;
}

// Tasks live in state.db's `tasks` table (db.ts), one row per task; the
// next id is meta 'tasks:nextId' so a removed task's id is never reused.
// Every change is a transaction, so concurrent `work todo` and work web
// edits can't clobber each other.

function isTask(x: unknown): x is Task {
  const t = x as Task | null;
  return !!t && typeof t === 'object' && typeof t.id === 'number' && typeof t.text === 'string';
}

function all(d: Db): Task[] {
  return (d.prepare('SELECT data FROM tasks ORDER BY id').all() as Array<{ data: string }>)
    .map((r) => json.parse(r.data))
    .filter(isTask);
}

function get(d: Db, id: number): Task | null {
  const r = d.prepare('SELECT data FROM tasks WHERE id = ?').get(id) as { data: string } | undefined;
  const t = r ? json.parse(r.data) : null;
  return isTask(t) ? t : null;
}

function put(d: Db, t: Task): void {
  d.prepare('INSERT OR REPLACE INTO tasks (id, data) VALUES (?, ?)').run(t.id, JSON.stringify(t));
}

function nextId(d: Db): number {
  const r = d.prepare("SELECT value FROM meta WHERE key = 'tasks:nextId'").get() as { value: string } | undefined;
  const max = (d.prepare('SELECT MAX(id) AS m FROM tasks').get() as { m: number | null }).m ?? 0;
  const id = Math.max(r ? Number(r.value) : 1, max + 1);
  d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('tasks:nextId', ?)").run(String(id + 1));
  return id;
}

/** Change one task in a transaction; null when it doesn't exist. */
function update(id: number, fn: (t: Task) => void): Task | null {
  return tx((d) => {
    const t = get(d, id);
    if (!t) return null;
    fn(t);
    put(d, t);
    return t;
  });
}

export function getTasks(): Task[] {
  return withDb(all);
}

export async function addTask(text: string, link?: string): Promise<Task> {
  return tx((d) => {
    const task: Task = {
      id: nextId(d),
      text,
      done: false,
      createdAt: new Date().toISOString(),
      link,
    };
    put(d, task);
    return task;
  });
}

export async function completeTask(id: number): Promise<Task | null> {
  return update(id, (t) => {
    t.done = true;
    t.doneAt = new Date().toISOString();
  });
}

export async function uncompleteTask(id: number): Promise<Task | null> {
  return update(id, (t) => {
    t.done = false;
    t.doneAt = undefined;
  });
}

export async function removeTask(id: number): Promise<Task | null> {
  return tx((d) => {
    const t = get(d, id);
    if (!t) return null;
    d.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return t;
  });
}

export async function editTask(id: number, text: string): Promise<Task | null> {
  return update(id, (t) => {
    t.text = text;
  });
}
