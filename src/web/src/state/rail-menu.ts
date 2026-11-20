import type { SessionSummary } from '../api/client.js';
import { RAIL_COLOR_LABEL, RAIL_COLORS, type PlacePatch, type RailColor, type RailLayout } from '../../../core/rail/rail-layout.js';
import type { MenuEntry, MenuItem, MenuSwatches } from '../components/Dashboard/RowMenu.js';

/** The class that gives an element a rail color (`--tag`, read by the bar, the square and the swatch). */
export function tagClass(color: RailColor): string {
  return `wd-tag-${color}`;
}

/**
 * "Color  ■ ■ ■ ■ ■ ■ ⊘": the six, then No color, marking what it has now
 * (null: no color; undefined: not one answer, several sessions differing). Pure.
 */
export function colorSwatches(
  current: RailColor | null | undefined,
  pick: (color: RailColor | null) => void,
  label = 'Color',
): MenuSwatches {
  return {
    label,
    separated: true,
    swatches: [
      ...RAIL_COLORS.map((c) => ({
        key: c,
        label: RAIL_COLOR_LABEL[c],
        className: tagClass(c),
        current: current === c,
        run: () => pick(c),
      })),
      { key: 'none', label: 'No color', current: current === null, run: () => pick(null) },
    ],
  };
}

/**
 * The rail row menu's pin, section and color part: Pin to top / Unpin, Move
 * to each of your sections, Out of the one it's in, New section…, then its
 * color. Pure.
 */
export function railMenuItems(
  s: SessionSummary,
  layout: RailLayout,
  a: { place: (s: SessionSummary, patch: PlacePatch) => void; newSection: (s: SessionSummary) => void },
): MenuEntry[] {
  const place = layout.places[s.id];
  const current = place?.section ? layout.sections.find((x) => x.id === place.section) : undefined;
  const items: MenuItem[] = [
    place?.pinned
      ? { label: 'Unpin', run: () => a.place(s, { pinned: false }), separated: true }
      : { label: 'Pin to top', run: () => a.place(s, { pinned: true }), separated: true },
  ];
  for (const sec of layout.sections) {
    if (sec.id === current?.id) continue;
    items.push({ label: `Move to “${sec.name}”`, run: () => a.place(s, { pinned: false, section: sec.id }) });
  }
  if (current) items.push({ label: `Take out of “${current.name}”`, run: () => a.place(s, { section: null }) });
  items.push({ label: 'New section…', run: () => a.newSection(s) });
  return [...items, colorSwatches(place?.color ?? null, (color) => a.place(s, { color }))];
}

export { newSectionId } from '../../../core/rail/rail-layout.js';

/** What a few sessions have in common: their one color, null when none has one, undefined when they differ. Pure. */
export function sharedColor(ids: readonly string[], layout: Pick<RailLayout, 'places'>): RailColor | null | undefined {
  const colors = new Set(ids.map((id) => layout.places[id]?.color ?? null));
  return colors.size === 1 ? [...colors][0] : undefined;
}
