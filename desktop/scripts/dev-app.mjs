#!/usr/bin/env node
// The dev app — "work dev", with the DEV icon — beside the installed one:
//
//   npm run app:dev    this checkout's build on your real sessions: the app
//                      shows the dev server (`work web --dev`), which it starts
//   npm run app:demo   the demo (`work web --demo`), started here and stopped
//                      with the app
//
// Builds the checkout first (dist/ is what the dev server and the demo
// serve), and restarts a running dev server so it serves this build. The app
// is `tauri dev` with tauri.dev.conf.json and the Cargo feature `dev`
// (main.rs DEV). Every command is an argv array, no shell (security §1.1).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'desktop');
const BIN = path.join(ROOT, 'dist', 'bin.js');
const demo = process.argv.includes('--demo');

function run(cmd, args, opts = {}) {
  const r = spawn.sync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

/** The demo's address, from its first lines ("work web DEMO at http://…", on stderr like all its messages). */
function startDemo() {
  const proc = spawn(process.execPath, [BIN, 'web', '--demo', '--no-open'], { stdio: ['ignore', 'inherit', 'pipe'] });
  const url = new Promise((resolve, reject) => {
    let seen = '';
    let found = false;
    proc.stderr.on('data', (d) => {
      process.stderr.write(d);
      if (found) return;
      seen += d;
      // Only once the line is whole: a chunk can end inside the address.
      const m = /DEMO at (http:\/\/[^\s\u001b]+)[\s\u001b]/.exec(seen);
      if (m) {
        found = true;
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => reject(new Error(`the demo exited (${code}) before it said where it runs`)));
    setTimeout(() => reject(new Error('the demo did not start within 30 s')), 30_000).unref();
  });
  return { proc, url };
}

run('npm', ['run', 'build'], { cwd: ROOT });
const env = { ...process.env };
// rustup puts cargo in ~/.cargo/bin, which isn't always on PATH (a shell that predates the install).
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
if (spawn.sync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0 && fs.existsSync(cargoBin)) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = `${cargoBin}${path.delimiter}${env[key] ?? ''}`;
}
let demoProc = null;
if (demo) {
  const d = startDemo();
  demoProc = d.proc;
  env.WORK_DESKTOP_URL = await d.url;
  console.log(`demo at ${env.WORK_DESKTOP_URL}`);
} else {
  // A dev server still running serves the build it started with: the app starts a fresh one.
  const stopped = spawn.sync(process.execPath, [BIN, 'web', '--dev', '--stop'], { stdio: 'inherit' });
  if (stopped.status !== 0) {
    console.error('The running dev server did not stop, so the app would show its old build. End it, then run this again.');
    process.exit(1);
  }
}

const app = spawn('npx', ['tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json', '--features', 'dev'], {
  cwd: DESKTOP,
  env,
  stdio: 'inherit',
});
const stop = () => {
  demoProc?.kill();
  app.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
app.on('exit', (code) => {
  demoProc?.kill();
  process.exit(code ?? 0);
});
