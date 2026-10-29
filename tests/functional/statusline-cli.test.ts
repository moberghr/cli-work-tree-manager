import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPidAlive, killTree } from '../../src/core/platform/process.js';

/**
 * `work hook statusline` through the BUILT binary, as Claude Code runs it on every status-line refresh: the JSON on
 * stdin, the line read from stdout, the process expected gone. Under a throwaway HOME. Needs `npm run build`.
 */

const BIN = path.resolve(__dirname, '../../dist/bin.js');
const hasBuild = fs.existsSync(BIN);

let home: string;
let pidFile: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-cli-'));
  pidFile = path.join(home, 'bg.pid');
});
afterEach(() => {
  // The user's line left a child running (on purpose): it goes with the test.
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf-8')) : 0;
  if (pid > 0 && isPidAlive(pid)) killTree(pid);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function hook(payload: unknown): Promise<{ code: number | null; stdout: string; ms: number }> {
  const started = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
  delete env.WORK_STATUSLINE_NESTED;
  delete env.CLAUDE_CONFIG_DIR;
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [BIN, 'hook', 'statusline'], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.on('error', reject);
    // 'close', not 'exit': every holder of its stdout has let go too, as Claude Code waits for.
    c.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    c.stdin.end(JSON.stringify(payload));
  });
}

describe.skipIf(!hasBuild)('work hook statusline (built binary)', { timeout: 30_000 }, () => {
  it("records the reading, prints the user's line, and exits at once though that line left a child on its stdout", async () => {
    const node = process.execPath.replace(/\\/g, '/');
    const js = 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)';
    // A long-lived child holding the line's stdout (`cmd &`), then the line itself.
    const original = `'${node}' -e '${js}' '${pidFile.replace(/\\/g, '/')}' & echo hi`;
    fs.mkdirSync(path.join(home, '.work'), { recursive: true });
    fs.writeFileSync(path.join(home, '.work', 'statusline.json'), JSON.stringify({ original: { type: 'command', command: original } }));

    const r = await hook({ cwd: home, rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_999_990_000 } } });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi\n');
    expect(r.ms).toBeLessThan(3000);
    const reading = JSON.parse(fs.readFileSync(path.join(home, '.work', 'usage', 'claude-default.json'), 'utf-8')) as {
      windows: Array<{ id: string; usedPercent: number }>;
    };
    expect(reading.windows).toEqual([expect.objectContaining({ id: 'five_hour', usedPercent: 42 })]);
  });

  it('with no line of the user, records and prints nothing', async () => {
    const r = await hook({ cwd: home, rate_limits: { seven_day: { used_percentage: 7 } } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(path.join(home, '.work', 'usage', 'claude-default.json'))).toBe(true);
  });
});
