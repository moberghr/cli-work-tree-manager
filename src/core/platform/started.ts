import type { ChildProcess } from 'node:child_process';
import { explainNotOnPath } from './program-path.js';

/**
 * Whether `child` started: null once it has (its `spawn` event), the reason when it couldn't (its `error` came
 * first — not installed, not allowed). A start fails after the call returns, so a caller that answered at once
 * answered "opened" for a program that never ran (Open in terminal said ok without Windows Terminal). Later errors
 * are swallowed: a server must not crash on a child it has let go of.
 */
export function whenStarted(child: Pick<ChildProcess, 'once' | 'on'>): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    child.once('spawn', () => {
      if (!settled) resolve(null);
      settled = true;
    });
    child.on('error', (err: Error) => {
      if (!settled) resolve(explainNotOnPath(err).message);
      settled = true;
    });
  });
}
