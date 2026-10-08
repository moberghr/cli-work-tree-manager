import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyConfigFiles } from '../../../src/core/worktree/copy-files.js';

describe('copyConfigFiles', () => {
  let repo: string;
  let worktree: string;
  const write = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), '{}');
  };
  const copied = (rel: string) => fs.existsSync(path.join(worktree, rel));

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-files-repo-'));
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-files-wt-'));
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('skips copies of the config inside CDK synth output', () => {
    write('App/appsettings.Development.json');
    write('cdk/cdk.out/asset.abc123/App/appsettings.Development.json');

    copyConfigFiles(repo, worktree, ['*.Development.json']);

    expect(copied('App/appsettings.Development.json')).toBe(true);
    expect(copied('cdk/cdk.out/asset.abc123/App/appsettings.Development.json')).toBe(false);
  });
});
