import { json, tx, withDb, type Db } from '../platform/db.js';
import {
  applyPlacePatch,
  applySectionOp,
  asRailPlace,
  cleanSections,
  type PlacePatch,
  type RailLayout,
  type RailPlace,
  type RailSection,
  type SectionOp,
} from './rail-layout.js';

/**
 * The rail's pins and sections in state.db (rail-layout.ts has the rules):
 * the sections in `meta` (one list, yours), each session's place in
 * `rail_place` (one row per session, gone with it: purgeSessionRows).
 */
const SECTIONS_KEY = 'ui:rail-sections';

function readSections(d: Db): RailSection[] {
  const row = d.prepare('SELECT value FROM meta WHERE key = ?').get(SECTIONS_KEY) as { value: string } | undefined;
  return (row && cleanSections(json.parse(row.value))) || [];
}

export function readRailLayout(): RailLayout {
  return withDb((d) => {
    const places: Record<string, RailPlace> = {};
    for (const r of d.prepare('SELECT session_id, data FROM rail_place').all() as Array<{ session_id: string; data: string }>) {
      const p = asRailPlace(json.parse(r.data));
      if (p) places[r.session_id] = p;
    }
    return { sections: readSections(d), places };
  });
}

/** One change to the sections, against the list as it is now (rail-layout.ts SectionOp). */
export function changeRailSections(op: SectionOp): PlaceResult {
  const error = tx((d) => {
    const r = applySectionOp(readSections(d), op);
    if (!r.ok) return r.error;
    writeSections(d, r.sections);
    return null;
  });
  return error ? { ok: false, error } : { ok: true, layout: readRailLayout() };
}

/** Replace the section list. Sessions in a removed section go back to the rest. */
export function saveRailSections(sections: RailSection[]): RailLayout {
  tx((d) => writeSections(d, sections));
  return readRailLayout();
}

function writeSections(d: Db, sections: RailSection[]): void {
  d.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(SECTIONS_KEY, JSON.stringify(sections));
  const known = new Set(sections.map((s) => s.id));
  for (const r of d.prepare('SELECT session_id, data FROM rail_place').all() as Array<{ session_id: string; data: string }>) {
    const p = asRailPlace(json.parse(r.data));
    if (!p?.section || known.has(p.section)) continue;
    writePlace(d, r.session_id, applyPlacePatch(p, { section: null }));
  }
}

export type PlaceResult = { ok: true; layout: RailLayout } | { ok: false; error: string };

/** Pin / unpin a session, or move it into or out of a section (which must exist). */
export function placeSession(sessionId: string, patch: PlacePatch): PlaceResult {
  const error = tx((d) => {
    if (patch.section && !readSections(d).some((s) => s.id === patch.section)) return 'no such section';
    const row = d.prepare('SELECT data FROM rail_place WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    const prev = row ? (asRailPlace(json.parse(row.data)) ?? undefined) : undefined;
    writePlace(d, sessionId, applyPlacePatch(prev, patch));
    return null;
  });
  return error ? { ok: false, error } : { ok: true, layout: readRailLayout() };
}

function writePlace(d: Db, sessionId: string, place: RailPlace | null): void {
  if (place) d.prepare('INSERT OR REPLACE INTO rail_place (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(place));
  else d.prepare('DELETE FROM rail_place WHERE session_id = ?').run(sessionId);
}
