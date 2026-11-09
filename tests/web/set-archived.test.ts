// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveCancelled, setArchived } from '../../src/web/src/api/client.js';

afterEach(() => vi.unstubAllGlobals());

function fakeServer() {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { force?: boolean };
      bodies.push(body);
      if (!body.force)
        return new Response(
          JSON.stringify({ error: 'Not archived', blocked: ['2 replies to post on review threads', 'its Claude is working'] }),
          { status: 409 },
        );
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
  return bodies;
}

describe('setArchived', () => {
  it('an Archive asks first, naming the session; declined, nothing is sent (and it is your choice, not an error)', async () => {
    const bodies = fakeServer();
    const asked: string[] = [];
    const err = await setArchived('s1', true, (q) => (asked.push(q), false), { name: 'feat/x' }).catch((e: unknown) => e);
    expect(asked).toHaveLength(1);
    expect(asked[0].startsWith('Archive “feat/x”?')).toBe(true);
    expect(asked[0]).toContain('Restore brings it all back');
    expect(archiveCancelled(err)).toBe(true);
    expect(bodies).toEqual([]);
  });

  it('a Restore and an Archive the caller asked about already (the bulk bar) are not asked', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => (bodies.push(JSON.parse(init.body)), new Response('{"ok":true}'))),
    );
    const confirm = vi.fn(() => false);
    await expect(setArchived('s1', false, confirm)).resolves.toEqual({ ok: true });
    await expect(setArchived('s1', true, confirm, { asked: true })).resolves.toEqual({ ok: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(bodies).toEqual([{ archived: false }, { archived: true }]);
  });

  it('asks when something is still waiting, and archives anyway when you say so', async () => {
    const bodies = fakeServer();
    const asked: string[] = [];
    await expect(setArchived('s1', true, (q) => (asked.push(q), true))).resolves.toEqual({ ok: true });
    expect(asked[0].startsWith('Archive this session?')).toBe(true); // no name given
    expect(asked[1]).toContain('• 2 replies to post on review threads');
    expect(asked[1]).toContain('• its Claude is working');
    expect(bodies).toEqual([{ archived: true }, { archived: true, force: true }]);
  });

  it('declined: nothing more is sent, and it says what was waiting', async () => {
    const bodies = fakeServer();
    await expect(setArchived('s1', true, () => false, { asked: true })).rejects.toThrow(
      'Not archived: 2 replies to post on review threads; its Claude is working',
    );
    expect(bodies).toHaveLength(1);
  });

  it('a Restore held up by what runs from its old folder: asks to stop it, and restores when you say so', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { stopHolders?: boolean };
        bodies.push(body);
        return body.stopHolders
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response(JSON.stringify({ error: 'still running', holders: ['node …vite.js --mode demo (PID 35464)'] }), { status: 409 });
      }),
    );
    const asked: string[] = [];
    await expect(setArchived('s1', false, (q) => (asked.push(q), true))).resolves.toEqual({ ok: true });
    expect(asked[0]).toContain('• node …vite.js --mode demo (PID 35464)');
    expect(asked[0]).toContain('Stop it and restore?');
    expect(bodies).toEqual([{ archived: false }, { archived: false, stopHolders: true }]);

    bodies.length = 0;
    await expect(setArchived('s1', false, () => false)).rejects.toThrow('still running'); // declined: nothing stopped
    expect(bodies).toHaveLength(1);
  });

  it('a 409 on Restore that names nothing is an error, not an empty "Stop it?"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Not restored: busy' }), { status: 409 })),
    );
    const confirm = vi.fn(() => true);
    await expect(setArchived('s1', false, confirm)).rejects.toThrow('Not restored: busy');
    expect(confirm).not.toHaveBeenCalled();
  });
});
