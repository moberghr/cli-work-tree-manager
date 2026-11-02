// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { hostHealth, hostHealthText, hostNeedsRestart, UNRESPONSIVE_MS } from '../../src/core/pty/host-health.js';
import { LatencyMeter } from '../../src/web/src/state/keystroke-latency.js';
import { HostHealthBanner } from '../../src/web/src/components/Dashboard/HostHealthBanner.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('hostHealth (pure)', () => {
  const now = 100_000;
  it('ok when it answered lately and quickly; slow; not answering after 11 s; none without a host', () => {
    expect(hostHealth({ known: true, lastOkAt: now - 2000, latencyMs: 12, lastError: null }, now).state).toBe('ok');
    expect(hostHealth({ known: true, lastOkAt: now - 2000, latencyMs: 2500, lastError: null }, now).state).toBe('slow');
    const dead = hostHealth({ known: true, lastOkAt: now - UNRESPONSIVE_MS - 1, latencyMs: 12, lastError: 'timeout' }, now);
    expect(dead).toMatchObject({ state: 'unresponsive', error: 'timeout' });
    expect(hostHealthText(dead)).toContain('not answering (11 s)');
    expect(hostHealth({ known: false, lastOkAt: null, latencyMs: null, lastError: null }, now).state).toBe('none');
    expect(hostHealthText(hostHealth({ known: true, lastOkAt: now, latencyMs: 5, lastError: null }, now))).toBeNull();
  });
});

describe('a host older than this work (it outlives updates)', () => {
  const now = 100_000;
  const beat = (hostVersion: string | null | undefined) => ({
    known: true,
    lastOkAt: now - 1000,
    latencyMs: 5,
    lastError: null,
    hostVersion,
  });

  it('says which release it runs, and offers Restart; the same release, unknown, or a dev build says nothing', () => {
    const old = hostHealth(beat('2.8.0'), now, '2.9.3');
    expect(old.outdated).toBe('2.8.0');
    expect(hostHealthText(old)).toContain('still runs 2.8.0, from before the update');
    expect(hostNeedsRestart(old)).toBe(true);
    expect(hostHealth(beat(''), now, '2.9.3').outdated).toBe('an older version'); // from before hosts said
    expect(hostHealth(beat('2.9.3'), now, '2.9.3').outdated).toBeNull();
    expect(hostHealth(beat(null), now, '2.9.3').outdated).toBeNull(); // not asked yet
    expect(hostHealth(beat(undefined), now, '2.9.3').outdated).toBeNull(); // an older pool
    expect(hostHealth(beat('2.8.0'), now, 'dev').outdated).toBeNull();
    expect(hostHealth(beat('2.9.3-dev.4+abc'), now, '2.9.3').outdated).toBeNull();
    expect(hostHealth(beat('2.8.0'), now).outdated).toBeNull(); // nothing to compare with
  });

  it('a host not answering offers Restart too; a slow one alone does not', () => {
    const dead = hostHealth({ known: true, lastOkAt: now - UNRESPONSIVE_MS - 1, latencyMs: 5, lastError: 'x' }, now, '2.9.3');
    expect(hostNeedsRestart(dead)).toBe(true);
    expect(hostHealthText(dead)).toContain('restarting it brings them back');
    expect(hostNeedsRestart(hostHealth({ known: true, lastOkAt: now, latencyMs: 2500, lastError: null }, now, '2.9.3'))).toBe(false);
  });
});

describe('LatencyMeter (pure)', () => {
  it('a key to its echo; typing ahead counts the first; a late "echo" is no sample; the median of the last', () => {
    const m = new LatencyMeter();
    expect(m.median()).toBeNull();
    m.keySent(0);
    m.keySent(5); // typed ahead: still from the first
    expect(m.output(20)).toBe(20);
    expect(m.output(25)).toBeNull(); // output with no key waiting
    m.keySent(100);
    expect(m.output(140)).toBe(40);
    m.keySent(200);
    expect(m.output(5000)).toBeNull(); // Claude redrawing anyway
    m.keySent(6000);
    m.output(6010);
    expect(m.median()).toBe(20); // 10, 20, 40
  });
});

describe('HostHealthBanner', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  it('shows only when the host is slow or not answering', () => {
    act(() => root.render(createElement(HostHealthBanner, { health: { state: 'ok', latencyMs: 4, quietMs: 1000, error: null } })));
    expect(container.textContent).toBe('');
    act(() =>
      root.render(createElement(HostHealthBanner, { health: { state: 'unresponsive', latencyMs: 4, quietMs: 15_000, error: 'x' } })),
    );
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('not answering (15 s)');
  });
});

describe('HostHealthBanner: Restart', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const outdated = { state: 'ok' as const, latencyMs: 5, quietMs: 1000, error: null, outdated: '2.8.0' };

  it('an older host: says so, and Restart restarts it and says it is coming back', async () => {
    const restart = vi.fn(async () => ({ outcome: 'stopped' as const, pid: 7 }));
    act(() => root.render(createElement(HostHealthBanner, { health: outdated, restart })));
    expect(container.textContent).toContain('still runs 2.8.0');
    const button = container.querySelector('button')!;
    await act(async () => button.click());
    expect(restart).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Restarting the terminal host: sessions resume in a moment.');
  });

  it('a refusal says why; a slow host has no Restart; a healthy one shows nothing', async () => {
    const restart = vi.fn(async () => Promise.reject(new Error("couldn't stop it")));
    act(() => root.render(createElement(HostHealthBanner, { health: outdated, restart })));
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain("Couldn't restart it: couldn't stop it");
    act(() => root.render(createElement(HostHealthBanner, { health: { state: 'slow', latencyMs: 2500, quietMs: 0, error: null } })));
    expect(container.querySelector('button')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    act(() =>
      root.render(createElement(HostHealthBanner, { health: { state: 'ok', latencyMs: 5, quietMs: 0, error: null, outdated: null } })),
    );
    expect(container.textContent).toBe('');
  });
});
