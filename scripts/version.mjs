// work's version, decided in one place for every build (tsup, Vite, the
// desktop packaging). The release tag is the only source, as in bearing
// (MinVer): `package.json` keeps a placeholder (0.0.0-dev) that nothing reads.
//
//   WORK_VERSION=2.1.0            the release jobs set it from the tag (vX.Y.Z)
//   git describe on a tag         that tag: v2.0.1 → 2.0.1
//   …3 commits past v2.0.1        2.0.2-dev.3+aeed538 (MinVer's way: above the
//                                 last release, so a dev build is never offered
//                                 the release it is ahead of)
//   neither (a shallow clone)     package.json's version
//
// Commands are argv arrays (§1.1).

import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `git describe --tags --long` output → a version, or null for anything else. */
export function versionFromDescribe(described) {
  const m = /^v(\d+)\.(\d+)\.(\d+)-(\d+)-g([0-9a-f]+)$/.exec((described ?? '').trim());
  if (!m) return null;
  const [, major, minor, patch, distance, sha] = m;
  if (distance === '0') return `${major}.${minor}.${patch}`;
  return `${major}.${minor}.${Number(patch) + 1}-dev.${distance}+${sha}`;
}

function gitDescribe(root) {
  const r = spawn.sync('git', ['describe', '--tags', '--long', '--match', 'v[0-9]*', '--abbrev=7'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/**
 * The version of the work in `root`. `env` and `describe` are injectable for
 * tests. Throws on a WORK_VERSION that isn't a version: a release must not
 * ship a guess.
 */
export function workVersion(root = process.cwd(), { env = process.env, describe = gitDescribe } = {}) {
  const given = env.WORK_VERSION?.trim().replace(/^v/, '');
  if (given) {
    if (!SEMVER.test(given)) throw new Error(`WORK_VERSION is not a version: ${JSON.stringify(env.WORK_VERSION)}`);
    return given;
  }
  const fromGit = versionFromDescribe(describe(root));
  if (fromGit) return fromGit;
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}
