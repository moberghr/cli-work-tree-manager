import { describe, it, expect } from 'vitest';
import {
  selectSessions,
  expandRunUnits,
  anyFailed,
  type RunResult,
} from '../../src/core/fleet.js';
import { extractRun, stripRunToken } from '../../src/commands/run.js';
import type { WorktreeSession } from '../../src/core/history.js';

function session(
  target: string,
  branch: string,
  paths: string[],
  isGroup = false,
): WorktreeSession {
  return {
    target,
    branch,
    paths,
    isGroup,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: '2026-01-01T00:00:00.000Z',
  };
}

const sessions: WorktreeSession[] = [
  session('api', 'feat/a', ['/wt/api/a']),
  session('api', 'feat/b', ['/wt/api/b']),
  session('web', 'feat/a', ['/wt/web/a']),
  session('full', 'feat/c', ['/wt/full/c/api', '/wt/full/c/web'], true),
];

describe('selectSessions', () => {
  it('returns all sessions with an empty filter', () => {
    expect(selectSessions(sessions, {})).toHaveLength(4);
  });

  it('filters by target', () => {
    const r = selectSessions(sessions, { target: 'api' });
    expect(r.map((s) => s.branch)).toEqual(['feat/a', 'feat/b']);
  });

  it('filters by target + branch to a single session', () => {
    const r = selectSessions(sessions, { target: 'api', branch: 'feat/b' });
    expect(r).toHaveLength(1);
    expect(r[0].branch).toBe('feat/b');
  });

  it('returns empty when nothing matches', () => {
    expect(selectSessions(sessions, { target: 'nope' })).toHaveLength(0);
  });
});

describe('expandRunUnits', () => {
  it('emits one unit per path, including each group path', () => {
    const units = expandRunUnits(sessions);
    expect(units).toHaveLength(5); // 3 single + 2 group paths
    const groupUnits = units.filter((u) => u.session.target === 'full');
    expect(groupUnits.map((u) => u.path)).toEqual([
      '/wt/full/c/api',
      '/wt/full/c/web',
    ]);
  });

  it('preserves stable session-then-path order', () => {
    const units = expandRunUnits(selectSessions(sessions, { target: 'api' }));
    expect(units.map((u) => u.path)).toEqual(['/wt/api/a', '/wt/api/b']);
  });
});

describe('stripRunToken', () => {
  it('drops the doubled run command token yargs reports in argv._', () => {
    expect(stripRunToken(['run', 'run', 'git', 'log'])).toEqual(['git', 'log']);
  });

  it('keeps a user-typed literal run after the command token', () => {
    expect(stripRunToken(['run', 'run', 'run', 'echo'])).toEqual([
      'run',
      'echo',
    ]);
  });

  it('handles the empty invocation', () => {
    expect(stripRunToken(['run', 'run'])).toEqual([]);
  });
});

describe('extractRun', () => {
  it('captures a user command with its own flag verbatim (--oneline)', () => {
    const { options, cmd } = extractRun(['git', 'log', '--oneline']);
    expect(cmd).toEqual(['git', 'log', '--oneline']);
    expect(options.parallel).toBeUndefined();
  });

  it('keeps a trailing user flag like eslint . --fix', () => {
    const { cmd } = extractRun(['eslint', '.', '--fix']);
    expect(cmd).toEqual(['eslint', '.', '--fix']);
  });

  it('does NOT let a user --parallel after the command be stolen', () => {
    const { options, cmd } = extractRun(['x', '--parallel']);
    expect(cmd).toEqual(['x', '--parallel']);
    expect(options.parallel).toBeUndefined();
  });

  it('parses our own leading fleet flags before the command', () => {
    const { options, cmd } = extractRun([
      '--parallel',
      '--target',
      'api',
      'git',
      'status',
    ]);
    expect(options.parallel).toBe(true);
    expect(options.target).toBe('api');
    expect(cmd).toEqual(['git', 'status']);
  });

  it('parses --jobs / -j and keeps the rest as the command', () => {
    expect(extractRun(['--jobs', '3', 'npm', 'test']).options.jobs).toBe(3);
    const j = extractRun(['-j', '2', 'npm', 'run', 'build']);
    expect(j.options.jobs).toBe(2);
    expect(j.cmd).toEqual(['npm', 'run', 'build']);
  });

  it('treats a literal -- as the explicit command boundary', () => {
    const { options, cmd } = extractRun([
      '--parallel',
      '--',
      'x',
      '--parallel',
    ]);
    expect(options.parallel).toBe(true);
    expect(cmd).toEqual(['x', '--parallel']);
  });

  it('returns an empty command for no args', () => {
    expect(extractRun([]).cmd).toEqual([]);
  });
});

describe('anyFailed', () => {
  const base = { session: sessions[0], path: '/wt/api/a' };
  it('is false when all ok', () => {
    const results: RunResult[] = [{ ...base, code: 0, ok: true }];
    expect(anyFailed(results)).toBe(false);
  });

  it('is true when any non-zero', () => {
    const results: RunResult[] = [
      { ...base, code: 0, ok: true },
      { ...base, code: 2, ok: false },
    ];
    expect(anyFailed(results)).toBe(true);
  });

  it('treats a signalled (null code) result as failure', () => {
    const results: RunResult[] = [{ ...base, code: null, ok: false }];
    expect(anyFailed(results)).toBe(true);
  });
});
