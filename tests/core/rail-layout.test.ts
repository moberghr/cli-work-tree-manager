import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  applyPlacePatch,
  cleanPlacePatch,
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

describe('the rail routes (state.db)', () => {
  const now = new Date().toISOString();
  const a = { target: 'api', branch: 'feat/a', isGroup: false, paths: ['/wt/a'], createdAt: now, lastAccessedAt: now };
  const b = { ...a, branch: 'feat/b', paths: ['/wt/b'] };
  const setup = () => {
    saveHistory([a, b]);
    const events: string[] = [];
    const app = new Hono();
    mountRailRoutes(app, { broadcast: (e) => void events.push(e) });
    const put = (path: string, body: unknown) => app.request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { app, put, events };
  };

  it('pin, sections, moving in and out; every window told; removing a section leaves its sessions in the rest', async () => {
    const { app, put, events } = setup();
    expect(await (await app.request('/api/rail')).json()).toEqual({ sections: [], places: {} });
    const ida = sessionIdFor(a);
    const idb = sessionIdFor(b);

    expect((await put(`/api/sessions/${ida}/rail`, { pinned: true })).status).toBe(200);
    expect((await put(`/api/sessions/${idb}/rail`, { section: 'x' })).status).toBe(409); // no such section yet
    expect((await put('/api/rail/sections', { sections: [{ id: 'x', name: 'Client X' }] })).status).toBe(200);
    const r = await put(`/api/sessions/${idb}/rail`, { section: 'x' });
    expect(await r.json()).toEqual({ sections: [{ id: 'x', name: 'Client X' }], places: { [ida]: { pinned: true }, [idb]: { section: 'x' } } });
    expect(events).toEqual(['rail-changed', 'rail-changed', 'rail-changed']);

    await put('/api/rail/sections', { sections: [] });
    expect(readRailLayout()).toEqual({ sections: [], places: { [ida]: { pinned: true } } });

    expect((await put('/api/sessions/nope/rail', { pinned: true })).status).toBe(404);
    expect((await put(`/api/sessions/${ida}/rail`, { pinned: 'yes' })).status).toBe(400);
    expect((await put('/api/rail/sections', { sections: [{ id: 'x', name: '' }] })).status).toBe(400);
  });

  it("a session's place goes with it (a re-created session starts unpinned)", async () => {
    setup();
    saveRailSections([{ id: 'x', name: 'X' }]);
    placeSession(sessionIdFor(a), { pinned: true, section: 'x' });
    await removeSession(a.target, a.branch);
    expect(readRailLayout().places).toEqual({});
  });
});
