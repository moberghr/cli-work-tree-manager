import { useCallback, useEffect, useState } from 'react';
import type { SettingsWire } from '../../../../../core/api-types.js';
import { SETTINGS_ELSEWHERE } from '../../../../../core/settings/settings-schema.js';
import { fetchSettings, saveSetting } from '../../../api/panes.js';
import { useSse } from '../../../api/events.js';
import { defaultText, settingSections, shownValue } from '../../../state/settings-view.js';
import { SettingInput } from '../SettingInput.js';

/**
 * Settings (`#/settings`, `g ,`): work's settings from config.json, by section (settings-schema.ts), each saved as you
 * change it. One set by hand shows "Reset" (back to its default); the default is said beside each. A repo's own
 * settings are on the Repos page (Settings… on its row).
 */
export function SettingsTab({
  api = { fetchSettings, saveSetting },
}: {
  api?: { fetchSettings: typeof fetchSettings; saveSetting: typeof saveSetting };
}) {
  const [data, setData] = useState<SettingsWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const load = useCallback(() => {
    api.fetchSettings().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the api is fixed for the page's life
  }, []);
  useEffect(load, [load]);
  useSse('/events', { events: { 'settings-changed': load } });

  if (error && !data) return <div className="wd-tab-empty wd-tab-error">Couldn&apos;t load the settings: {error}</div>;
  if (!data) return <div className="wd-tab-empty">Loading…</div>;

  const save = (path: string) => (value: unknown) => api.saveSetting(path, value).then(setData);
  const sections = settingSections(filter);
  return (
    <div className="wd-dash-tab-pane wd-tab-settings">
      <header className="wd-tab-header">
        <h1>Settings</h1>
        <div className="wd-tab-controls">
          <input
            type="search"
            className="wd-settings-filter"
            placeholder="Find a setting"
            aria-label="Find a setting"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </header>
      <p className="wd-settings-intro">
        Saved to <code>{data.configPath}</code> as you change them. A repo&apos;s own settings — which checks count, its dev command, its
        reviews — are on the <a href="#/repos">Repos page</a> (Settings… on its row).
      </p>
      {sections.length === 0 && <p className="wd-web-muted">No setting matches “{filter}”.</p>}
      {sections.map(({ section, fields }) => (
        <section key={section} className="wd-settings-section" aria-label={section}>
          <h2>{section}</h2>
          {fields.map((f) => {
            const { value, set } = shownValue(f, data.values);
            const id = `setting-${f.path}`;
            const def = defaultText(f);
            return (
              <div key={f.path} className={'wd-setting' + (set ? ' wd-setting-set' : '')}>
                <label htmlFor={id} className="wd-setting-label">
                  {f.label}
                </label>
                <div className="wd-setting-control">
                  <SettingInput
                    id={id}
                    kind={f.kind}
                    value={value}
                    placeholder={'placeholder' in f.kind ? f.kind.placeholder : undefined}
                    onSave={save(f.path)}
                  />
                  {set && !f.required && (
                    <button
                      type="button"
                      className="wd-link-button"
                      title={def ? `Back to the default: ${def}` : 'Take it out of config.json'}
                      onClick={() => void save(f.path)(null).catch((e: Error) => setError(e.message))}
                    >
                      Reset
                    </button>
                  )}
                </div>
                <p className="wd-setting-help">
                  {f.help}
                  {def !== null && <span className="wd-web-muted"> Default: {def}.</span>}
                  {f.when && <span className="wd-web-muted"> Takes effect {f.when}.</span>}
                </p>
              </div>
            );
          })}
        </section>
      ))}
      {error && data && (
        <p className="wd-setting-error" role="alert">
          {error}
        </p>
      )}
      <p className="wd-settings-elsewhere wd-web-muted">{SETTINGS_ELSEWHERE}</p>
    </div>
  );
}
