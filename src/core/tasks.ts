import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { atomicWriteFile, ensureFile, withFileLock } from './fs-safe.js';

export interface Task {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
  /** Optional link to a worktree session (target:branch). */
  link?: string;
}

interface TaskStore {
  nextId: number;
  tasks: Task[];
}

const EMPTY_STORE: TaskStore = { nextId: 1, tasks: [] };

function getTasksPath(): string {
  return path.join(getConfigDir(), 'tasks.json');
}

function loadStore(): TaskStore {
  const p = getTasksPath();
  if (!fs.existsSync(p)) return { ...EMPTY_STORE };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
      return { ...EMPTY_STORE };
    }
    return parsed;
  } catch {
    return { ...EMPTY_STORE };
  }
}

function saveStore(store: TaskStore): void {
  atomicWriteFile(getTasksPath(), JSON.stringify(store, null, 2));
}

/**
 * Serialize read-modify-write against other work2 processes so concurrent
 * `work2 todo` / TUI edits can't clobber each other.
 */
async function withTasksLock<T>(fn: () => T): Promise<T> {
  const tasksPath = getTasksPath();
  ensureFile(tasksPath, JSON.stringify(EMPTY_STORE, null, 2));
  return withFileLock(tasksPath, fn);
}

export function getTasks(): Task[] {
  return loadStore().tasks;
}

export async function addTask(text: string, link?: string): Promise<Task> {
  return withTasksLock(() => {
    const store = loadStore();
    const task: Task = {
      id: store.nextId++,
      text,
      done: false,
      createdAt: new Date().toISOString(),
      link,
    };
    store.tasks.push(task);
    saveStore(store);
    return task;
  });
}

export async function completeTask(id: number): Promise<Task | null> {
  return withTasksLock(() => {
    const store = loadStore();
    const task = store.tasks.find((t) => t.id === id);
    if (!task) return null;
    task.done = true;
    task.doneAt = new Date().toISOString();
    saveStore(store);
    return task;
  });
}

export async function uncompleteTask(id: number): Promise<Task | null> {
  return withTasksLock(() => {
    const store = loadStore();
    const task = store.tasks.find((t) => t.id === id);
    if (!task) return null;
    task.done = false;
    task.doneAt = undefined;
    saveStore(store);
    return task;
  });
}

export async function removeTask(id: number): Promise<Task | null> {
  return withTasksLock(() => {
    const store = loadStore();
    const idx = store.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const [removed] = store.tasks.splice(idx, 1);
    saveStore(store);
    return removed;
  });
}

export async function editTask(id: number, text: string): Promise<Task | null> {
  return withTasksLock(() => {
    const store = loadStore();
    const task = store.tasks.find((t) => t.id === id);
    if (!task) return null;
    task.text = text;
    saveStore(store);
    return task;
  });
}

export function getTasksPath_(): string {
  return getTasksPath();
}
