import { useEffect, useState } from 'react';
import type { SettingsWire } from '../../../../core/api-types.js';
import { fetchSettings, saveSetting } from '../../api/panes.js';

/**
 * Asked once, in the update card's corner, while config `claudeStatusLine` was never set and the user has no status
 * line of their own (`SettingsWire.ownStatusLine`): show work's own status
 * line under each Claude (model and context, account, folder, branch: work-line.ts), or keep the user's. Either
 * answer is saved as the setting (Settings → Agents & terminals), so it isn't asked again — on any browser.
 */
export function StatusLineAsk({
  load = fetchSettings,
  save = saveSetting,
}: {
  load?: () => Promise<SettingsWire>;
  save?: (path: string, value: unknown) => Promise<SettingsWire>;
}) {
  // null: not known yet (or the settings didn't read): nothing is asked.
  const [unset, setUnset] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      // Someone with a line of their own keeps it: not asked (Settings still offers work's).
      (s) => live && setUnset(!('claudeStatusLine' in s.values) && !s.ownStatusLine),
      () => live && setUnset(null),
    );
    return () => {
      live = false;
    };
  }, [load]);
  if (!unset) return null;
  const choose = (value: 'work' | 'own') => {
    setSaving(true);
    setError(null);
    save('claudeStatusLine', value).then(
      () => setUnset(false),
      (e: Error) => {
        setSaving(false);
        setError(e.message);
      },
    );
  };
  return (
    <div className="wd-update-strip" role="status" aria-label="Status line">
      <span className="wd-update-text">Show a status line under each Claude?</span>
      <span className="wd-update-actions">
        <button type="button" className="wd-link-button" disabled={saving} onClick={() => choose('own')}>
          Keep mine
        </button>
        <button type="button" className="wd-btn-primary" disabled={saving} onClick={() => choose('work')}>
          Show it
        </button>
      </span>
      <span className="wd-update-sub">
        The model and how full its context is, the account, the folder and the branch — drawn by work, nothing to install. Change it any
        time in Settings.
      </span>
      {error && (
        <span className="wd-repos-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
