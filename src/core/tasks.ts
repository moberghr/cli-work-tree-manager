import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';

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

function getTasksPath(): string {
  return path.join(getConfigDir(), 'tasks.json');
}

function loadStore(): TaskStore {
  const p = getTasksPath();
  if (!fs.existsSync(p)) return { nextId: 1, tasks: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { nextId: 1, tasks: [] };
  }
}

function saveStore(store: TaskStore): void {
  fs.writeFileSync(getTasksPath(), JSON.stringify(store, null, 2), 'utf-8');
}

export function getTasks(): Task[] {
  return loadStore().tasks;
}

export function addTask(text: string, link?: string): Task {
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
}

export function completeTask(id: number): Task | null {
  const store = loadStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return null;
  task.done = true;
  task.doneAt = new Date().toISOString();
  saveStore(store);
  return task;
}

export function uncompleteTask(id: number): Task | null {
  const store = loadStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return null;
  task.done = false;
  task.doneAt = undefined;
  saveStore(store);
  return task;
}

export function removeTask(id: number): Task | null {
  const store = loadStore();
  const idx = store.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const [removed] = store.tasks.splice(idx, 1);
  saveStore(store);
  return removed;
}

export function editTask(id: number, text: string): Task | null {
  const store = loadStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return null;
  task.text = text;
  saveStore(store);
  return task;
}

export function getTasksPath_(): string {
  return getTasksPath();
}
