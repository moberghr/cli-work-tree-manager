import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Run every test's git — and every process tests spawn — against an EMPTY
 * git config, not the developer's.
 *
 * Why: tests make real commits. A developer config with commit signing
 * (e.g. `commit.gpgsign=true` + SSH signing through an agent), global
 * hooks, templates or aliases makes those commits depend on the machine —
 * and a signing agent that is slow or pops an approval prompt blocks a
 * synchronous `git commit` indefinitely, freezing the whole test worker
 * (vitest can't even time it out). Seen once as a 10-minute stall.
 *
 * Set before any test file loads (vitest setupFiles), so it also reaches
 * child processes: the built `work` binary, the PTY host, fake tools.
 */
const empty = path.join(os.tmpdir(), 'work-tests-empty.gitconfig');
if (!fs.existsSync(empty)) fs.writeFileSync(empty, '');

process.env.GIT_CONFIG_GLOBAL = empty;
process.env.GIT_CONFIG_NOSYSTEM = '1';
// No global config means no identity: give commits one.
process.env.GIT_AUTHOR_NAME ??= 'work-tests';
process.env.GIT_AUTHOR_EMAIL ??= 'work-tests@example.invalid';
process.env.GIT_COMMITTER_NAME ??= 'work-tests';
process.env.GIT_COMMITTER_EMAIL ??= 'work-tests@example.invalid';
// Never wait for a credential/username prompt.
process.env.GIT_TERMINAL_PROMPT = '0';
