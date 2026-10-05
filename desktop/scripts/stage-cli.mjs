#!/usr/bin/env node
// Stage the `work` CLI into the desktop app's package: a `cli/` folder, smoke
// tested, then packed as one `cli.zip` next to the app's executable
// (packCliArchive); runtime.rs unpacks it to ~/.work/runtime/<version>.
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
import { listFiles, readStoredZip, zipDirectory } from './zip-store.mjs';

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

/**
 * Files in node_modules nothing runs: docs, type definitions, source maps, debug symbols,
 * TypeScript sources, test / example folders, and the C/C++ sources the two
 * native modules were built from. About half the files (3,282 → ~1,650 in
 * 2.0.1), and every file costs: an update rewrites each one, and the
 * installed copy is written again under ~/.work/runtime. Licenses stay.
 * `rel` is the path inside node_modules, with forward slashes.
 */
export function trimmable(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (/licen[cs]e|notice|copying/i.test(base)) return false;
  return (
    /\.(md|markdown)$/i.test(base) ||
    /\.d\.[cm]?ts$/.test(base) ||
    /\.map$/.test(base) ||
    /\.pdb$/i.test(base) || // Windows debug symbols (node-pty's prebuilds: ~25 MB)
    /\.[cm]?ts$/.test(base) ||
    /(^|\/)(tests?|__tests__|examples?|docs?|\.github|benchmarks?)\//.test(rel) ||
    /^(better-sqlite3|node-pty)\/(deps|src)\//.test(rel)
  );
}

function trimNodeModules(nodeModules) {
  if (!fs.existsSync(nodeModules)) return 0;
  let removed = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
      } else if (trimmable(path.relative(nodeModules, p).split(path.sep).join('/'))) {
        fs.rmSync(p, { force: true });
        removed++;
      }
    }
  })(nodeModules);
  return removed;
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
  trimNodeModules(path.join(out, 'node_modules'));
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
  // --help loads every command, and with them every dependency they import:
  // a file the trim took that something still needs fails here, not on a user's machine.
  const help = spawn.sync(node, [path.join(out, 'dist', 'bin.js'), '--help'], { encoding: 'utf8' });
  if (help.status !== 0) throw new Error(`work --help failed (exit ${help.status}):\n${help.stderr}`);
  // The native modules, and the packages loaded only on first use (core/platform/spawn.ts, fs-safe.ts, fs-watcher.ts), which --help doesn't reach.
  const load = ['better-sqlite3', 'node-pty', 'cross-spawn', 'proper-lockfile', 'chokidar'].map((m) => `require('${m}');`).join(' ');
  const native = spawn.sync(node, ['-e', `${load} console.log('ok')`], {
    cwd: out,
    encoding: 'utf8',
  });
  if (native.status !== 0 || native.stdout.trim() !== 'ok')
    throw new Error(`native modules don't load on the bundled Node:\n${native.stderr}`);
}

/**
 * The staged (and smoke-tested) `cli/` as one file for the package: `cli.zip`
 * beside it, its version in `cli.version` (read without opening the zip), the
 * folder removed. runtime.rs unpacks it into ~/.work/runtime/<version>. Each
 * entry is read back first: a damaged archive must not ship.
 */
export function packCliArchive(cliDir) {
  const parent = path.dirname(cliDir);
  const zip = path.join(parent, 'cli.zip');
  const version = fs.readFileSync(path.join(cliDir, 'VERSION'), 'utf8').trim();
  const files = listFiles(cliDir);
  zipDirectory(cliDir, zip);
  const entries = readStoredZip(zip);
  const missing = files.filter((f, i) => entries[i]?.name !== f);
  if (entries.length !== files.length || missing.length)
    throw new Error(`cli.zip doesn't hold what cli/ does (${missing.slice(0, 3).join(', ')})`);
  fs.writeFileSync(path.join(parent, 'cli.version'), version);
  fs.rmSync(cliDir, { recursive: true, force: true });
  return { zip, version, files: files.length };
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
