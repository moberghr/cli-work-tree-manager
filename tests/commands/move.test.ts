import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  unsavedWork: vi.fn(),
  exportBundle: vi.fn(),
  importBundle: vi.fn(),
  runningHere: vi.fn(),
}));
vi.mock('../../src/core/move/move.js', async (orig) => ({ ...(await orig<object>()), ...core }));
vi.mock('../../src/core/sessions/history.js', () => ({ loadHistory: () => [] }));
import { moveCommand } from '../../src/commands/move.js';
import { MoveError } from '../../src/core/move/move.js';

let out: string[];
const run = (argv: Record<string, unknown>) => (moveCommand.handler as (a: unknown) => Promise<void>)({ _: ['move'], ...argv });

beforeEach(() => {
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  for (const f of Object.values(core)) f.mockReset();
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('work move', () => {
  it('export: work only on this computer stops it (unless --force), naming each', async () => {
    core.unsavedWork.mockResolvedValue([{ session: 'api · feat/x', repo: 'api', path: '/wt/x', what: '2 commits not pushed' }]);
    await run({ action: 'export', dir: 'bundle' });
    expect(core.exportBundle).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(out.join('\n')).toContain('api · feat/x: 2 commits not pushed');
    core.exportBundle.mockReturnValue({ dir: '/b', sessions: 3, transcripts: 5 });
    await run({ action: 'export', dir: 'bundle', force: true });
    expect(core.exportBundle).toHaveBeenCalled();
  });

  it('import: refused while work web or the PTY host runs; otherwise passes the options and reports', async () => {
    core.runningHere.mockResolvedValue(['work web (`work web --stop`)']);
    await run({ action: 'import', dir: 'bundle' });
    expect(core.importBundle).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('Stop work web');

    core.runningHere.mockResolvedValue([]);
    core.importBundle.mockResolvedValue({
      sessions: 2,
      transcripts: 1,
      repos: { cloned: [], missing: ['web'] },
      worktrees: { created: ['api · feat/x'], failed: [{ session: 'web · fix/y', error: "its repo isn't here (web)" }] },
    });
    await run({ action: 'import', dir: 'bundle', clone: true, 'repos-root': 'r' });
    expect(core.importBundle.mock.calls[0][1]).toMatchObject({ clone: true, force: false, reposRoot: expect.stringMatching(/r$/) });
    const text = out.join('\n');
    expect(text).toContain('Not on this computer: web');
    expect(text).toContain("web · fix/y: its repo isn't here (web)");
  });

  it('a refusal from core is a message, not a crash', async () => {
    core.runningHere.mockResolvedValue([]);
    core.importBundle.mockRejectedValue(new MoveError('work here has sessions already'));
    await run({ action: 'import', dir: 'bundle' });
    expect(process.exitCode).toBe(1);
    expect(out.join('\n')).toContain('sessions already');
  });
});
