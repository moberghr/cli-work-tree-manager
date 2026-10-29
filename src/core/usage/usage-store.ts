import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../platform/config.js';
import { atomicWriteFile } from '../platform/fs-safe.js';
import { debugLog } from '../platform/logger.js';
import type { UsageAccount, UsageWindow } from './usage.js';

// Readings the agents' hooks leave behind, one file per agent and account. The status-line hook calls recordReading on every refresh, so it stays cheap.

/** A reading that hasn't changed is rewritten only when its time is this old: the age stays honest without a write per refresh. */
const REFRESH_MS = 60_000;

type Stored = Omit<UsageAccount, 'account'>;

export const usageDir = () => path.join(getConfigDir(), 'usage');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isWindow(v: unknown): v is UsageWindow {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.label === 'string' &&
    typeof v.usedPercent === 'number' &&
    (v.resetsAt === null || typeof v.resetsAt === 'string') &&
    (v.reset === undefined || v.reset === true)
  );
}

function parseStored(text: string): Stored | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.at !== 'string' || !Array.isArray(v.windows) || !v.windows.every(isWindow)) return null;
  return { at: v.at, windows: v.windows };
}

const fileFor = (agent: string, account: string) => path.join(usageDir(), `${agent}-${account}.json`);

/**
 * Within one window (same id, same known reset) usage only grows: an idle agent's redraw can carry an older, lower figure
 * than another session just reported, and it mustn't win.
 */
function keepHigher(stored: UsageWindow[], fresh: UsageWindow[]): UsageWindow[] {
  return fresh.map((w) => {
    const was = w.resetsAt === null ? undefined : stored.find((s) => s.id === w.id && s.resetsAt === w.resetsAt);
    return was && was.usedPercent > w.usedPercent ? { ...w, usedPercent: was.usedPercent } : w;
  });
}

/** Keep a reading. Writes only when it changed (or the stored time is over a minute old); returns whether it wrote. Never throws. */
export function recordReading(agent: string, account: string, windows: UsageWindow[], now = Date.now()): boolean {
  if (windows.length === 0) return false;
  try {
    const file = fileFor(agent, account);
    let stored: Stored | null = null;
    try {
      stored = parseStored(fs.readFileSync(file, 'utf-8'));
    } catch {
      /* nothing stored yet */
    }
    const kept = stored ? keepHigher(stored.windows, windows) : windows;
    if (stored && JSON.stringify(stored.windows) === JSON.stringify(kept) && now - Date.parse(stored.at) < REFRESH_MS) return false;
    fs.mkdirSync(usageDir(), { recursive: true });
    atomicWriteFile(file, JSON.stringify({ at: new Date(now).toISOString(), windows: kept }));
    return true;
  } catch (e) {
    // Only the log: this runs in an agent's hook (Claude's status line), which shows nothing of ours.
    const err = e as NodeJS.ErrnoException;
    debugLog('WARN', `[usage] reading not kept: ${err.code ? `${err.code} ` : ''}${err.message ?? String(e)}`);
    return false;
  }
}

/** Every account's last reading for an agent, by account name. A file that isn't a reading is skipped. */
export function readReadings(agent: string): UsageAccount[] {
  let names: string[];
  try {
    names = fs.readdirSync(usageDir());
  } catch {
    return [];
  }
  const prefix = `${agent}-`;
  const out: UsageAccount[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    try {
      const stored = parseStored(fs.readFileSync(path.join(usageDir(), name), 'utf-8'));
      if (stored) out.push({ account: name.slice(prefix.length, -'.json'.length), ...stored });
    } catch {
      /* unreadable: skipped */
    }
  }
  return out.sort((a, b) => a.account.localeCompare(b.account));
}
