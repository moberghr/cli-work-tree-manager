#!/usr/bin/env node
// Stage the `work` CLI into the desktop app's package (the `cli/` folder next
// to the app's executable; runtime.rs copies it to ~/.work/runtime/<version>).
//
//   node desktop/scripts/stage-cli.mjs <out-dir>
//
// What npm would install for `@moberg_hr/work-tree`: the package's `files`
// (dist, the postinstall script, the Claude plugin), its production
// dependencies, plus the Node runtime that runs it — THIS node, so the native
// modules npm builds or downloads (better-sqlite3, node-pty) match its ABI.
// Build the CLI first (`npm run build`). Every command is an argv array, no
// shell (security §1.1).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { workVersion } from '../../scripts/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What goes in: the npm package's `files`, plus its lockfile for `npm ci` (npm-shrinkwrap.json, which npm also publishes). */
export function cliFiles(pkg) {
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  return ['package.json', 'npm-shrinkwrap.json', ...files];
}

export const nodeName = (platform = process.platform) => (platform === 'win32' ? 'node.exe' : 'node');

const PREBUILD = /^(darwin|linux|linuxmusl|win32)-(x64|arm64|ia32|arm)(\.node)?$/;

/**
 * The entries of a package's `prebuilds/` this platform never loads: native
 * modules ship one per platform (node-pty and better-sqlite3 load
 * `prebuilds/<platform>-<arch>`), about 65 MB of the package. Names in another
 * layout are left alone.
 */
export function foreignPrebuilds(names, platform = process.platform, arch = process.arch) {
  const mine = `${platform}-${arch}`;
  return names.filter((n) => PREBUILD.test(n) && n.replace(/\.node$/, '') !== mine);
}

function pruneForeignPrebuilds(nodeModules) {
  if (!fs.existsSync(nodeModules)) return;
  const pkgs = [];
  for (const name of fs.readdirSync(nodeModules)) {
    if (name.startsWith('@')) for (const sub of fs.readdirSync(path.join(nodeModules, name))) pkgs.push(path.join(nodeModules, name, sub));
    else pkgs.push(path.join(nodeModules, name));
  }
  for (const pkg of pkgs) {
    const dir = path.join(pkg, 'prebuilds');
    if (!fs.existsSync(dir)) continue;
    for (const n of foreignPrebuilds(fs.readdirSync(dir))) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  }
}

/** Run, fail loudly. */
function run(cmd, args, opts) {
  const r = spawn.sync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
  return r;
}

export function stageCli(out, { root = ROOT, node = process.execPath, install = true } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!fs.existsSync(path.join(root, 'dist', 'bin.js'))) throw new Error('dist/bin.js is missing: run `npm run build` first');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of cliFiles(pkg)) {
    const from = path.join(root, f);
    if (!fs.existsSync(from)) throw new Error(`${f} is missing`);
    fs.cpSync(from, path.join(out, f), { recursive: true });
  }
  if (install) {
    // CI=1: the package's postinstall (Claude plugin setup) skips itself; the
    // app runs it on its first start instead, on the user's machine.
    run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: out,
      env: { ...process.env, CI: '1', WORK_TREE_SKIP_PLUGIN_SETUP: '1' },
    });
  }
  pruneForeignPrebuilds(path.join(out, 'node_modules'));
  fs.copyFileSync(node, path.join(out, nodeName()));
  fs.chmodSync(path.join(out, nodeName()), 0o755);
  // Written last: runtime.rs takes a cli/ with a VERSION as complete.
  // The same version the build put into the CLI (scripts/version.mjs): the smoke test compares them.
  const version = workVersion(root);
  fs.writeFileSync(path.join(out, 'VERSION'), version);
  return version;
}

/** The staged CLI runs, with its native modules, on its own Node. */
export function smokeTest(out) {
  const node = path.join(out, nodeName());
  const v = spawn.sync(node, [path.join(out, 'dist', 'bin.js'), '--version'], { encoding: 'utf8' });
  const want = fs.readFileSync(path.join(out, 'VERSION'), 'utf8').trim();
  if (v.status !== 0 || v.stdout.trim() !== want)
    throw new Error(`work --version said ${JSON.stringify(v.stdout?.trim())} (exit ${v.status}), wanted ${want}`);
  const native = spawn.sync(node, ['-e', "require('better-sqlite3'); require('node-pty'); console.log('ok')"], {
    cwd: out,
    encoding: 'utf8',
  });
  if (native.status !== 0 || native.stdout.trim() !== 'ok')
    throw new Error(`native modules don't load on the bundled Node:\n${native.stderr}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node desktop/scripts/stage-cli.mjs <out-dir>');
    process.exit(2);
  }
  const version = stageCli(path.resolve(out));
  smokeTest(path.resolve(out));
  console.log(`staged work ${version} with Node ${process.version} at ${out}`);
}
