import type { SessionSummary } from '../api/client.js';
import type { PlacePatch, RailLayout } from '../../../core/rail/rail-layout.js';
import type { MenuItem } from '../components/Dashboard/RowMenu.js';

/**
 * The rail row menu's pin and section part: Pin to top / Unpin, Move to
 * each of your sections, Out of the one it's in, New section…. Pure.
 */
export function railMenuItems(
  s: SessionSummary,
  layout: RailLayout,
  a: { place: (s: SessionSummary, patch: PlacePatch) => void; newSection: (s: SessionSummary) => void },
): MenuItem[] {
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
  return items;
}

export { newSectionId } from '../../../core/rail/rail-layout.js';
