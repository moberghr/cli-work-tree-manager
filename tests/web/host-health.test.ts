// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { hostHealth, hostHealthText, UNRESPONSIVE_MS } from '../../src/core/host-health.js';
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
    act(() => root.render(createElement(HostHealthBanner, { health: { state: 'unresponsive', latencyMs: 4, quietMs: 15_000, error: 'x' } })));
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('not answering (15 s)');
  });
});
