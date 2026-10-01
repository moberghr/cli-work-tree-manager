import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  applyPlacePatch,
  applySectionOp,
  cleanPlacePatch,
  cleanSectionOp,
  cleanSections,
  groupRail,
  placeForGroup,
  type RailLayout,
} from '../../src/core/rail-layout.js';
import { placeSession, readRailLayout, saveRailSections } from '../../src/core/rail-store.js';
import { mountRailRoutes } from '../../src/core/rail-routes.js';
import { removeSession, saveHistory } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';

const list = (...ids: string[]) => ids.map((id) => ({ id }));
const keys = (groups: ReturnType<typeof groupRail>) => groups.map((g) => [g.key, g.title, g.sessions.map((s) => s.id)]);

describe('groupRail', () => {
  it('nothing placed: one untitled group, as before', () => {
    expect(keys(groupRail(list('a', 'b'), { sections: [], places: {} }))).toEqual([['rest', null, ['a', 'b']]]);
  });

  it('Pinned, then your sections in your order (empty ones too), then Other — each keeping the rail order', () => {
    const layout: RailLayout = {
      sections: [{ id: 'x', name: 'Client X' }, { id: 'y', name: 'Waiting' }],
      places: { c: { pinned: true }, a: { section: 'x' }, d: { section: 'x' }, b: { pinned: true, section: 'x' } },
    };
    expect(keys(groupRail(list('a', 'b', 'c', 'd', 'e'), layout))).toEqual([
      ['pinned', 'Pinned', ['b', 'c']], // pinned wins over a section
      ['section:x', 'Client X', ['a', 'd']],
      ['section:y', 'Waiting', []],
      ['rest', 'Other', ['e']],
    ]);
  });

  it('a place naming a removed section counts as the rest; pins alone leave the rest untitled', () => {
    expect(keys(groupRail(list('a', 'b'), { sections: [], places: { a: { section: 'gone' }, b: { pinned: true } } }))).toEqual([
      ['pinned', 'Pinned', ['b']],
      ['rest', null, ['a']],
    ]);
  });

  it('everything placed: an empty Other stays (somewhere to drag a row out of its section or pin)', () => {
    expect(keys(groupRail(list('a'), { sections: [], places: { a: { pinned: true } } }))).toEqual([
      ['pinned', 'Pinned', ['a']],
      ['rest', 'Other', []],
    ]);
  });

  it('dropping into a group: what that means for the place', () => {
    expect(placeForGroup({ key: 'pinned' })).toEqual({ pinned: true });
    expect(placeForGroup({ key: 'section:x', sectionId: 'x' })).toEqual({ pinned: false, section: 'x' });
    expect(placeForGroup({ key: 'rest' })).toEqual({ pinned: false, section: null });
  });
});

describe('places and sections: validation', () => {
  it('a patch: pinned is a boolean, section an id or null; anything else is refused', () => {
    expect(cleanPlacePatch({ pinned: true })).toEqual({ pinned: true });
    expect(cleanPlacePatch({ section: null })).toEqual({ section: null });
    expect(cleanPlacePatch({ pinned: 'yes' })).toBeNull();
    expect(cleanPlacePatch({ section: '' })).toBeNull();
    expect(cleanPlacePatch({})).toBeNull();
    expect(cleanPlacePatch(null)).toBeNull();
  });

  it('applying one; back to nowhere is no row at all', () => {
    expect(applyPlacePatch(undefined, { pinned: true })).toEqual({ pinned: true });
    expect(applyPlacePatch({ pinned: true }, { pinned: false, section: 'x' })).toEqual({ section: 'x' });
    expect(applyPlacePatch({ section: 'x' }, { section: null })).toBeNull();
  });

  it('sections: trimmed names, unique ids, at most 30', () => {
    expect(cleanSections([{ id: 'a1', name: '  Client X ' }])).toEqual([{ id: 'a1', name: 'Client X' }]);
    expect(cleanSections([{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }])).toBeNull();
    expect(cleanSections([{ id: 'a', name: '   ' }])).toBeNull();
    expect(cleanSections([{ id: 'a b', name: 'x' }])).toBeNull();
    expect(cleanSections(Array.from({ length: 31 }, (_, i) => ({ id: `s${i}`, name: 'n' })))).toBeNull();
  });
});

describe('section changes (one at a time, to the list as it is)', () => {
  const two = [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }];
  it('add, rename, move (an edge is a no-op), remove', () => {
    expect(applySectionOp(two, { op: 'add', id: 'z', name: 'Z' })).toEqual({ ok: true, sections: [...two, { id: 'z', name: 'Z' }] });
    expect(applySectionOp(two, { op: 'rename', id: 'y', name: 'Why' })).toEqual({ ok: true, sections: [two[0], { id: 'y', name: 'Why' }] });
    expect(applySectionOp(two, { op: 'move', id: 'y', by: -1 })).toEqual({ ok: true, sections: [two[1], two[0]] });
    expect(applySectionOp(two, { op: 'move', id: 'x', by: -1 })).toEqual({ ok: true, sections: two });
    expect(applySectionOp(two, { op: 'remove', id: 'x' })).toEqual({ ok: true, sections: [two[1]] });
  });
  it('refused: one another window removed, a duplicate, too many', () => {
    expect(applySectionOp(two, { op: 'rename', id: 'gone', name: 'n' })).toMatchObject({ ok: false, error: expect.stringContaining('no such section') });
    expect(applySectionOp(two, { op: 'add', id: 'x', name: 'n' })).toMatchObject({ ok: false });
    const full = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: 'n' }));
    expect(applySectionOp(full, { op: 'add', id: 'new', name: 'n' })).toMatchObject({ ok: false, error: 'at most 30 sections' });
  });
  it('validation', () => {
    expect(cleanSectionOp({ op: 'add', id: 'a', name: '  A ' })).toEqual({ op: 'add', id: 'a', name: 'A' });
    expect(cleanSectionOp({ op: 'add', id: 'a', name: ' ' })).toBeNull();
    expect(cleanSectionOp({ op: 'move', id: 'a', by: 2 })).toBeNull();
    expect(cleanSectionOp({ op: 'drop', id: 'a' })).toBeNull();
    expect(cleanSectionOp({ op: 'remove', id: 'a b' })).toBeNull();
  });
});

describe('the rail routes (state.db)', () => {
  const now = new Date().toISOString();
  const a = { target: 'api', branch: 'feat/a', isGroup: false, paths: ['/wt/a'], createdAt: now, lastAccessedAt: now };
  const b = { ...a, branch: 'feat/b', paths: ['/wt/b'] };
  const setup = () => {
    saveHistory([a, b]);
    const events: string[] = [];
    const app = new Hono();
    mountRailRoutes(app, { broadcast: (e) => void events.push(e) });
    const send = (method: string) => (path: string, body: unknown) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { app, put: send('PUT'), post: send('POST'), events };
  };

  it('pin, sections, moving in and out; every window told; removing a section leaves its sessions in the rest', async () => {
    const { app, put, post, events } = setup();
    expect(await (await app.request('/api/rail')).json()).toEqual({ sections: [], places: {} });
    const ida = sessionIdFor(a);
    const idb = sessionIdFor(b);

    expect((await put(`/api/sessions/${ida}/rail`, { pinned: true })).status).toBe(200);
    expect((await put(`/api/sessions/${idb}/rail`, { section: 'x' })).status).toBe(409); // no such section yet
    expect((await post('/api/rail/sections', { op: 'add', id: 'x', name: 'Client X' })).status).toBe(200);
    const r = await put(`/api/sessions/${idb}/rail`, { section: 'x' });
    expect(await r.json()).toEqual({ sections: [{ id: 'x', name: 'Client X' }], places: { [ida]: { pinned: true }, [idb]: { section: 'x' } } });
    expect(events).toEqual(['rail-changed', 'rail-changed', 'rail-changed']);

    // Two windows: one renames a section the other has just removed — refused, not resurrected.
    await post('/api/rail/sections', { op: 'remove', id: 'x' });
    expect(readRailLayout()).toEqual({ sections: [], places: { [ida]: { pinned: true } } });
    expect((await post('/api/rail/sections', { op: 'rename', id: 'x', name: 'Client X2' })).status).toBe(409);
    expect(readRailLayout().sections).toEqual([]);

    expect((await put('/api/sessions/nope/rail', { pinned: true })).status).toBe(404);
    expect((await put(`/api/sessions/${ida}/rail`, { pinned: 'yes' })).status).toBe(400);
    expect((await post('/api/rail/sections', { op: 'add', id: 'x', name: '' })).status).toBe(400);
  });

  it("a session's place goes with it (a re-created session starts unpinned)", async () => {
    setup();
    saveRailSections([{ id: 'x', name: 'X' }]);
    placeSession(sessionIdFor(a), { pinned: true, section: 'x' });
    await removeSession(a.target, a.branch);
    expect(readRailLayout().places).toEqual({});
  });
});
