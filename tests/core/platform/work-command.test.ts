import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shQuote, workCommand, workInvocation } from '../../../src/core/platform/work-command.js';
import { shellFor } from '../../../src/core/agents/claude/statusline-run.js';

/**
 * How Claude Code runs THIS work for a hook or its status line. Reported: a bare `work hook turn-end` ran an old
 * `npm link` that PATH found first, which knew no `turn-end` and printed its usage as a hook error on every turn.
 */
describe('workInvocation', () => {
  it('an npm (or checkout) install: its node and its real bin.js, never a bare `work`', () => {
    expect(
      workInvocation({ argv1: '/usr/lib/node_modules/w/dist/bin.js', execPath: '/usr/bin/node', configDir: '/h/.work', platform: 'linux' }),
    ).toEqual(['/usr/bin/node', '/usr/lib/node_modules/w/dist/bin.js']);
    // Run as `wd`: its sibling, the `work` binary.
    // (the sibling is joined with this platform's separator: resolveWorkBinPath's own)
    expect(workInvocation({ argv1: '/x/dist/wd-bin.js', execPath: '/n', configDir: '/h/.work', platform: 'linux' })).toEqual([
      '/n',
      path.join('/x/dist', 'bin.js'),
    ]);
  });

  it('the desktop app’s runtime copy (gone after an update): its stable launcher on POSIX, when it is there', () => {
    const d = {
      argv1: '/h/.work/runtime/2.11.3/dist/bin.js',
      execPath: '/h/.work/runtime/2.11.3/node',
      configDir: '/h/.work',
      platform: 'linux' as const,
    };
    expect(workInvocation({ ...d, exists: (p) => p === '/h/.work/bin/work' })).toEqual(['/h/.work/bin/work']);
    expect(workInvocation({ ...d, exists: () => false })).toEqual(['/h/.work/runtime/2.11.3/node', '/h/.work/runtime/2.11.3/dist/bin.js']);
  });

  it('Windows: node and the script, in forward slashes (Git Bash runs the hooks and starts no .cmd)', () => {
    expect(
      workCommand(['hook', 'turn-end'], {
        argv1: 'C:\\Users\\a b\\.work\\runtime\\2.1\\dist\\bin.js',
        execPath: 'C:\\Users\\a b\\.work\\runtime\\2.1\\node.exe',
        configDir: 'C:\\Users\\a b\\.work',
        platform: 'win32',
        exists: () => true,
      }),
    ).toBe("'C:/Users/a b/.work/runtime/2.1/node.exe' 'C:/Users/a b/.work/runtime/2.1/dist/bin.js' hook turn-end");
  });
});

describe('shQuote', () => {
  it('leaves plain words as they are and quotes the rest so sh reads them back unchanged', () => {
    expect(shQuote('/usr/bin/node', 'linux')).toBe('/usr/bin/node');
    for (const w of ["/home/o'neil/work", '/a b/$HOME/`x`', 'a;b&c|d']) {
      // The shell Claude Code runs hooks in: sh, Git Bash on Windows.
      const sh = shellFor();
      const out = spawnSync(sh.file, sh.args(`printf %s ${shQuote(w, 'linux')}`), { encoding: 'utf-8', windowsHide: true }).stdout;
      expect(out).toBe(w);
    }
  });
});
