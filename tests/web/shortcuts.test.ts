import { describe, expect, it, vi } from 'vitest';
import {
  keyText,
  runSessionKey,
  SESSION_KEYS,
  sessionActionFor,
  sessionKey,
  shortcutGroups,
  type SessionAction,
  type SessionKeyHandlers,
} from '../../src/web/src/state/shortcuts.js';

describe('the open session’s keys', () => {
  it('a key and its Shift are different actions; Ctrl, Alt and ⌘ are never ours', () => {
    expect(sessionActionFor({ key: 'e' })).toBe('archive');
    expect(sessionActionFor({ key: 'S', shiftKey: true })).toBe('ship');
    expect(sessionActionFor({ key: 's' })).toBeNull();
    expect(sessionActionFor({ key: 'N', shiftKey: true })).toBe('notes');
    expect(sessionActionFor({ key: 'Delete', shiftKey: true })).toBe('delete');
    expect(sessionActionFor({ key: 'Delete' })).toBeNull();
    expect(sessionActionFor({ key: '2' })).toBe('tab-diff');
    expect(sessionActionFor({ key: 'e', ctrlKey: true })).toBeNull();
    expect(sessionActionFor({ key: 'e', altKey: true })).toBeNull();
  });

  it('none takes a key the dashboard already uses anywhere (c, n, j, k, g, /, ?, [, ])', () => {
    const taken = new Set(['c', 'n', 'j', 'k', 'g', '/', '?', '[', ']']);
    const seen = new Set<string>();
    for (const d of Object.values(SESSION_KEYS)) {
      const id = `${d.shift ? 'shift+' : ''}${d.key}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
      if (!d.shift) expect(taken.has(d.key), d.key).toBe(false);
    }
  });

  it('written for menus and the list: e, ⇧S, ⇧Del', () => {
    expect(sessionKey('archive')).toBe('e');
    expect(sessionKey('ship')).toBe('⇧S');
    expect(sessionKey('delete')).toBe('⇧Del');
    expect(keyText({ key: '.' })).toBe('.');
  });

  it('the ? list has every one of them', () => {
    const listed = shortcutGroups().flatMap((g) => g.rows.map((r) => r.keys));
    for (const d of Object.values(SESSION_KEYS)) expect(listed).toContain(keyText(d));
    expect(listed).toEqual(expect.arrayContaining(['c', '?', 'g r', 'g c', '] / [']));
  });
});

describe('runSessionKey', () => {
  const handlers = () => {
    const calls: string[] = [];
    const h: SessionKeyHandlers = {
      tab: (t) => calls.push(`tab ${t}`),
      setArchived: (a) => calls.push(`archived ${a}`),
      snoozeMenu: () => calls.push('snooze'),
      blockBy: () => calls.push('block'),
      openEditor: () => calls.push('editor'),
      copyBranch: () => calls.push('copy'),
      fork: () => calls.push('fork'),
      remove: () => calls.push('delete'),
      header: (a) => calls.push(`header ${a}`),
    };
    return { h, calls };
  };
  const all = Object.keys(SESSION_KEYS) as SessionAction[];

  it('each key runs what its button does; the header gets its own', () => {
    const { h, calls } = handlers();
    for (const a of all) runSessionKey(a, { archived: false }, h);
    expect(calls).toEqual([
      'tab term',
      'tab diff',
      'tab timeline',
      'archived true',
      'snooze',
      'block',
      'header menu',
      'header prompt',
      'header catchup',
      'header notes',
      'header ship',
      'header terminal',
      'editor',
      'copy',
      'fork',
      'header dev',
      'delete',
    ]);
  });

  it('an archived session: e restores it; snooze, blocked by, editor and fork do nothing', () => {
    const { h, calls } = handlers();
    for (const a of ['archive', 'snooze', 'block', 'editor', 'fork', 'copy'] as SessionAction[]) runSessionKey(a, { archived: true }, h);
    expect(calls).toEqual(['archived false', 'copy']);
  });

  it('the header hand-off is only for what the header owns', () => {
    const header = vi.fn();
    const { h } = handlers();
    for (const a of all) runSessionKey(a, { archived: false }, { ...h, header });
    expect(header.mock.calls.map((c) => c[0])).toEqual(['menu', 'prompt', 'catchup', 'notes', 'ship', 'terminal', 'dev']);
  });
});
