#!/usr/bin/env node
// Best-effort: register the work-tree Claude Code plugin marketplace and
// install the bundled plugin (wd-review skill) when the `claude` CLI is
// available. Never fails the npm install — every step is optional.

import { spawnSync } from 'node:child_process';

const MARKETPLACE_REPO = 'moberghr/moberg-plugins';
const MARKETPLACE_NAME = 'moberg-plugins';
const PLUGIN_SPEC = 'work-tree@moberg-plugins';

// All argv values below are static literals — nothing user-controlled is
// interpolated. shell:true is required on Windows where `claude` is a .cmd shim.
function claude(args) {
  return spawnSync('claude', args, {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 60_000,
  });
}

function main() {
  if (process.env.CI || process.env.WORK_TREE_SKIP_PLUGIN_SETUP) return;

  const probe = claude(['--version']);
  if (probe.error || probe.status !== 0) return; // claude CLI not installed — skip silently

  const list = claude(['plugin', 'marketplace', 'list']);
  const known = !list.error && list.status === 0 && (list.stdout ?? '').includes(MARKETPLACE_NAME);

  if (!known) {
    const add = claude([
      'plugin', 'marketplace', 'add', MARKETPLACE_REPO,
      '--scope', 'user',
      '--sparse', '.claude-plugin',
    ]);
    if (add.error || add.status !== 0) {
      console.log('work-tree: could not register the Claude Code plugin marketplace (run `claude plugin marketplace add ' + MARKETPLACE_REPO + '` manually).');
      return;
    }
    console.log('work-tree: registered Claude Code plugin marketplace "' + MARKETPLACE_NAME + '".');
  }

  const install = claude(['plugin', 'install', PLUGIN_SPEC, '--scope', 'user']);
  if (install.error || install.status !== 0) {
    // Already installed or transient failure — either way, not fatal.
    return;
  }
  console.log('work-tree: installed Claude Code plugin "' + PLUGIN_SPEC + '" (wd-review skill).');
}

try {
  main();
} catch {
  // Never break npm install over optional plugin setup.
}
