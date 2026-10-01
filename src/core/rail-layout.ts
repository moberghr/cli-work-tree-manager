/**
 * PURE — shared by the SPA, the demo and the server; keep it import-free.
 *
 * The rail's pins and sections: a few sessions pinned to the top, and your
 * own headings ("Client X", "Waiting on review") with sessions under them.
 * Stored in state.db (rail-store.ts): the sections in `meta`, each session's
 * place in `rail_place` (gone with the session). Within a group, rows keep
 * the rail's order (your drag order, else the stable one).
 */

export interface RailSection {
  id: string;
  name: string;
}

/** Where one session sits: pinned wins over a section. */
export interface RailPlace {
  pinned?: boolean;
  section?: string;
}

export interface RailLayout {
  sections: RailSection[];
  /** By session id; a session without one is in no section and not pinned. */
  places: Record<string, RailPlace>;
}

export const EMPTY_RAIL_LAYOUT: RailLayout = { sections: [], places: {} };
export const MAX_SECTIONS = 30;
export const MAX_SECTION_NAME = 40;

export interface RailGroup<T> {
  /** 'pinned', 'rest', or `section:<id>`. */
  key: string;
  /** Null for the rest when there are no sections (nothing to tell it from). */
  title: string | null;
  sectionId?: string;
  sessions: T[];
}

/**
 * The rail in groups: Pinned, then each section in your order (empty ones
 * too — something to drop a row into), then the rest. A place naming a
 * section that is gone counts as the rest. Pure.
 */
export function groupRail<T extends { id: string }>(list: readonly T[], layout: RailLayout): RailGroup<T>[] {
  const known = new Set(layout.sections.map((s) => s.id));
  const pinned: T[] = [];
  const bySection = new Map<string, T[]>();
  const rest: T[] = [];
  for (const s of list) {
    const p = layout.places[s.id];
    if (p?.pinned) pinned.push(s);
    else if (p?.section && known.has(p.section)) bySection.set(p.section, [...(bySection.get(p.section) ?? []), s]);
    else rest.push(s);
  }
  const out: RailGroup<T>[] = [];
  if (pinned.length) out.push({ key: 'pinned', title: 'Pinned', sessions: pinned });
  for (const sec of layout.sections) out.push({ key: `section:${sec.id}`, title: sec.name, sectionId: sec.id, sessions: bySection.get(sec.id) ?? [] });
  if (rest.length || out.length === 0) out.push({ key: 'rest', title: layout.sections.length ? 'Other' : null, sessions: rest });
  return out;
}

/** What dropping a row into a group means for its place. */
export function placeForGroup(group: Pick<RailGroup<unknown>, 'key' | 'sectionId'>): PlacePatch {
  if (group.key === 'pinned') return { pinned: true };
  if (group.sectionId) return { pinned: false, section: group.sectionId };
  return { pinned: false, section: null };
}

/** A change to one session's place; `section: null` takes it out of its section. */
export interface PlacePatch {
  pinned?: boolean;
  section?: string | null;
}

/** Validate a PUT body's place change; null when it isn't one. */
export function cleanPlacePatch(raw: unknown): PlacePatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: PlacePatch = {};
  if ('pinned' in o) {
    if (typeof o.pinned !== 'boolean') return null;
    out.pinned = o.pinned;
  }
  if ('section' in o) {
    if (o.section !== null && (typeof o.section !== 'string' || !o.section || o.section.length > 64)) return null;
    out.section = o.section as string | null;
  }
  return 'pinned' in out || 'section' in out ? out : null;
}

/** The place after a patch, or null when it is back to nowhere (no row to keep). */
export function applyPlacePatch(prev: RailPlace | undefined, patch: PlacePatch): RailPlace | null {
  const next: RailPlace = { ...prev };
  if (patch.pinned !== undefined) {
    if (patch.pinned) next.pinned = true;
    else delete next.pinned;
  }
  if (patch.section !== undefined) {
    if (patch.section) next.section = patch.section;
    else delete next.section;
  }
  return next.pinned || next.section ? next : null;
}

/** Validate the section list (names trimmed, ids unique, bounded); null when it isn't one. */
export function cleanSections(raw: unknown): RailSection[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_SECTIONS) return null;
  const seen = new Set<string>();
  const out: RailSection[] = [];
  for (const x of raw) {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o.id !== 'string' || !/^[\w-]{1,64}$/.test(o.id) || typeof o.name !== 'string') return null;
    const name = o.name.trim().slice(0, MAX_SECTION_NAME);
    if (!name || seen.has(o.id)) return null;
    seen.add(o.id);
    out.push({ id: o.id, name });
  }
  return out;
}

/** A stored place, shape-checked (a row from state.db). */
export function asRailPlace(v: unknown): RailPlace | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const out: RailPlace = {};
  if (o.pinned === true) out.pinned = true;
  if (typeof o.section === 'string' && o.section) out.section = o.section;
  return out.pinned || out.section ? out : null;
}
