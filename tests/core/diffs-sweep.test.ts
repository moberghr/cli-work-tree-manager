import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sweepOldDiffArtifacts } from '../../src/core/diffs-sweep.js';

let dir: string;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-30T12:00:00Z');
const make = (name: string, ageDays: number, content = 'x') => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  const t = new Date(now - ageDays * DAY);
  fs.utimesSync(f, t, t);
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffs-sweep-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('sweepOldDiffArtifacts', () => {
  it('removes old static pages and daemon logs, keeps recent ones and every manifest', () => {
    make('aaa.html', 45, 'x'.repeat(1000));
    make('bbb.log', 90);
    make('ccc.html', 2);
    make('ddd.checkpoints.json', 200);
    make('ddd.checkpoints.json.lock', 200);
    expect(sweepOldDiffArtifacts(now, 30, dir)).toEqual({ removed: 2, bytes: 1001 });
    expect(fs.readdirSync(dir).sort()).toEqual(['ccc.html', 'ddd.checkpoints.json', 'ddd.checkpoints.json.lock']);
  });

  it('is a no-op when the folder does not exist', () => {
    expect(sweepOldDiffArtifacts(now, 30, path.join(dir, 'missing'))).toEqual({ removed: 0, bytes: 0 });
  });
});
