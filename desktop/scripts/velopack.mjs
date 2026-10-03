#!/usr/bin/env node
// Build the desktop app's Velopack release for this machine's platform:
// the Tauri app plus the `work` CLI it ships with (stage-cli.mjs), packed
// into an installer and a self-updating package, and — with PUBLISH=1 —
// uploaded to the GitHub Release of package.json's version (vX.Y.Z, the
// same release that publishes npm). Modeled on bearing's build/velopack.sh.
//
//   node desktop/scripts/velopack.mjs               # build + pack
//   PUBLISH=1 node desktop/scripts/velopack.mjs     # ...and upload (needs a GitHub token: GITHUB_TOKEN or `gh auth`)
//   SKIP_BUILD=1 ...                                # reuse dist/ and the Tauri binary
//   CARGO_TARGET_DIR=<dir> ...                      # build elsewhere (beside a running copy of the app)
//
//   win-x64   → WorkDesktop-win-Setup.exe + .nupkg + releases.win.json     (channel "win")
//   osx-arm64 → .pkg + .app zip + .nupkg + releases.osx.json               (channel "osx"; on a Mac only)
//   linux-x64 → .AppImage + .nupkg + releases.linux.json                   (channel "linux")
//
// Each platform builds on its own OS: the native modules in the CLI are
// built for the machine that stages them. Commands are argv arrays (§1.1).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { smokeTest, stageCli } from './stage-cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'desktop');
const REPO_URL = 'https://github.com/moberghr/cli-work-tree-manager';

// The Velopack identity. Permanent: changing it orphans every installed copy.
// Not "work": the Windows installer owns %LocalAppData%\<packId> and deletes
// it on uninstall; the user's state lives in ~/.work, which it never touches.
export const PACK_ID = 'WorkDesktop';
const PACK_TITLE = 'work';
const PACK_AUTHORS = 'Moberg';
const BUNDLE_ID = 'hr.moberg.work-desktop'; // = tauri.conf.json identifier; permanent on macOS too

export function target(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64')
    return { rid: 'win-x64', directive: '[win]', channel: 'win', exe: 'work-desktop.exe', icon: 'src-tauri/icons/icon.ico', pkgTag: '' };
  if (platform === 'darwin' && arch === 'arm64')
    return { rid: 'osx-arm64', directive: '[osx]', channel: 'osx', exe: 'work-desktop', icon: 'src-tauri/icons/icon.icns', pkgTag: '-osx' };
  if (platform === 'linux' && arch === 'x64')
    return {
      rid: 'linux-x64',
      directive: '[linux]',
      channel: 'linux',
      exe: 'work-desktop',
      icon: 'src-tauri/icons/icon.png',
      pkgTag: '-linux',
    };
  throw new Error(`no desktop package for ${platform}-${arch} (win-x64, osx-arm64 and linux-x64 are built)`);
}

/** The assets a published release must carry for this channel (vpk names the win package without a channel). */
export function requiredAssets(t, version) {
  return [`releases.${t.channel}.json`, `${PACK_ID}-${version}${t.pkgTag}-full.nupkg`];
}

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawn.sync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
}

function capture(cmd, args) {
  const r = spawn.sync(cmd, args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function main() {
  const t = target();
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const tag = `v${version}`;
  const work = path.join(DESKTOP, 'artifacts', 'velopack', t.rid);
  const packDir = path.join(work, 'pack');
  const releases = path.join(work, 'releases');
  const token = process.env.GITHUB_TOKEN || capture('gh', ['auth', 'token']);

  if (!capture('vpk', ['--help'])) throw new Error("'vpk' is not on PATH: dotnet tool install -g vpk");

  if (!process.env.SKIP_BUILD) {
    run('npm', ['run', 'build'], { cwd: ROOT });
    run('npm', ['ci'], { cwd: DESKTOP });
    run('npx', ['tauri', 'build', '--no-bundle'], { cwd: DESKTOP });
  }

  // The app, and the CLI beside it (runtime.rs looks for cli/ next to the executable).
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });
  // CARGO_TARGET_DIR: e.g. to build beside a running copy of the app (Windows won't overwrite its exe).
  const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(DESKTOP, 'src-tauri', 'target');
  fs.copyFileSync(path.join(targetDir, 'release', t.exe), path.join(packDir, t.exe));
  stageCli(path.join(packDir, 'cli'));
  smokeTest(path.join(packDir, 'cli'));

  // The previous release, so vpk can build a delta against it. Optional: the
  // first release has none, and a miss only costs users a full download.
  fs.rmSync(releases, { recursive: true, force: true });
  fs.mkdirSync(releases, { recursive: true });
  const dl = spawn.sync(
    'vpk',
    ['download', 'github', '--repoUrl', REPO_URL, '--channel', t.channel, '--outputDir', releases, ...(token ? ['--token', token] : [])],
    { stdio: 'inherit' },
  );
  if (dl.status !== 0) console.log('  no previous release found (or unreachable): this one ships as a full package only.');

  const extra = [];
  if (t.channel === 'win') extra.push('--shortcuts', 'StartMenuRoot');
  if (t.channel === 'linux') extra.push('--categories', 'Development');
  if (t.channel === 'osx') {
    extra.push('--bundleId', BUNDLE_ID);
    // Unsigned unless these are set (no Developer ID yet): one Gatekeeper step for the user.
    if (process.env.SIGN_APP_IDENTITY) extra.push('--signAppIdentity', process.env.SIGN_APP_IDENTITY);
    if (process.env.SIGN_INSTALL_IDENTITY) extra.push('--signInstallIdentity', process.env.SIGN_INSTALL_IDENTITY);
    if (process.env.NOTARY_PROFILE) extra.push('--notaryProfile', process.env.NOTARY_PROFILE);
  }
  run('vpk', [
    t.directive,
    'pack',
    '--packId',
    PACK_ID,
    '--packTitle',
    PACK_TITLE,
    '--packAuthors',
    PACK_AUTHORS,
    '--packVersion',
    version,
    '--packDir',
    packDir,
    '--mainExe',
    t.exe,
    '--icon',
    path.join(DESKTOP, t.icon),
    '--runtime',
    t.rid,
    '--channel',
    t.channel,
    '--outputDir',
    releases,
    ...extra,
  ]);

  if (process.env.PUBLISH !== '1') {
    console.log(`\nPacked work ${version} (${t.rid}) in ${releases}. Not published (PUBLISH=1 uploads to ${tag}).`);
    return;
  }
  if (!token) throw new Error('PUBLISH=1 needs a GitHub token (GITHUB_TOKEN, or `gh auth login`)');
  // --merge: each platform's channel lands on the same release, beside npm's.
  run('vpk', [
    'upload',
    'github',
    '--repoUrl',
    REPO_URL,
    '--token',
    token,
    '--channel',
    t.channel,
    '--outputDir',
    releases,
    '--publish',
    '--merge',
    '--releaseName',
    `work ${version}`,
    '--tag',
    tag,
  ]);

  // A release without the feed is invisible to every installed copy: check it landed.
  const assets = capture('gh', [
    'release',
    'view',
    tag,
    '--repo',
    REPO_URL,
    '--json',
    'assets',
    '--jq',
    '[.assets[].name] | join(" ")',
  ]).split(' ');
  const missing = requiredAssets(t, version).filter((a) => !assets.includes(a));
  if (missing.length) throw new Error(`the release ${tag} is missing ${missing.join(', ')}: re-run the upload before calling it released`);
  console.log(`\nPublished work ${version} (${t.rid}) to ${tag}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
