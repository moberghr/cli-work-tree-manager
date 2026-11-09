import { SETTING_SECTIONS, SETTINGS, type SettingField, type SettingSection } from '../../../core/settings/settings-schema.js';

/**
 * The Settings page and a repo's settings, read for the screen (pure): what each field shows, whether it was set or is
 * its default, and a list's text as typed (one entry per line).
 */

/** A field's value as config.json has it, else its default; and whether it was set. */
export function shownValue(field: SettingField, values: Record<string, unknown>): { value: unknown; set: boolean } {
  return field.path in values ? { value: values[field.path], set: true } : { value: field.default, set: false };
}

/** The default in words, for the "default: …" hint (nothing for a field with none). */
export function defaultText(field: SettingField): string | null {
  const d = field.default;
  if (d === null) return null;
  if (typeof d === 'boolean') return d ? 'on' : 'off';
  if (Array.isArray(d)) return d.length ? d.join(', ') : 'none';
  if (d === 0 && field.kind.type === 'number' && field.kind.zeroOff) return '0 (off)';
  return String(d);
}

/** A list as it is typed: one entry per line. */
export const listText = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : '');

/** What was typed into a list's box, as its entries: one a line (not split at commas: a glob like `*.{json,env}` has them). */
export const parseList = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The page's sections, each with its fields, in order; with a filter, only the fields it matches (label, help, path). */
export function settingSections(filter = ''): Array<{ section: SettingSection; fields: SettingField[] }> {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (f: SettingField) => {
    const hay = `${f.label} ${f.help} ${f.path} ${f.section}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  return SETTING_SECTIONS.map((section) => ({ section, fields: SETTINGS.filter((f) => f.section === section && matches(f)) })).filter(
    (s) => s.fields.length > 0,
  );
}

/** Same value? (A list compared item by item: saving one that didn't change is skipped.) */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}
