import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the path to the `work` binary given the path of whichever
 * binary `wd`/`work` is currently running as. The `web` subcommand
 * only lives on the `work` binary (`dist/bin.js`); when we're running
 * as the `wd` shim (`dist/wd-bin.js`) we swap to the sibling. Tsup
 * ships both into the same dir so the sibling-swap is always valid.
 *
 * Used wherever we spawn `work` itself (work web autostart, the PTY host,
 * login autostart) — never pass `web`/`pty-host` args to the `wd` shim.
 */
export function resolveWorkBinPath(selfArgv1: string): string {
  // argv[1] may be a bin symlink, not the real file: a global npm install
  // exposes `wd` as e.g. ~/.../bin/wd -> ../lib/.../dist/wd-bin.js. Resolve
  // it so the wd-bin.js -> bin.js sibling-swap fires for global installs too;
  // otherwise we'd spawn the `wd` shim with `web` args and it'd fail.
  let real = selfArgv1;
  try {
    real = fs.realpathSync(selfArgv1);
  } catch {
    /* synthetic/non-existent path (e.g. unit tests) — use as given */
  }
  if (real.endsWith('wd-bin.js')) {
    return path.join(path.dirname(real), 'bin.js');
  }
  return real;
}
