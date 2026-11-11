import { useCallback, useEffect, useState } from 'react';
import type { RepoSettingsWire } from '../../../../core/api-types.js';
import { fetchRepoSettings, saveRepoSetting } from '../../api/panes.js';
import { useSse } from '../../api/events.js';
import { SettingInput } from './SettingInput.js';

/** One array for every render: a new `[]` each time made the input reset what you were typing (its value changed). */
const NO_CHECKS: string[] = [];

/**
 * A repo's settings (`#/repos/<alias>`, Settings… on its row of the Repos page): which failed checks count on its
 * PRs, the command Start dev server runs, and whether its PRs are reviewed in the background — each saved as you
 * change it — with its folder, origin and host.
 */
export function RepoSettings({
  alias,
  api = { fetchRepoSettings, saveRepoSetting },
}: {
  alias: string;
  api?: { fetchRepoSettings: typeof fetchRepoSettings; saveRepoSetting: typeof saveRepoSetting };
}) {
  const [data, setData] = useState<RepoSettingsWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.fetchRepoSettings(alias).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the api is fixed for the panel's life
  }, [alias]);
  useEffect(load, [load]);
  useSse('/events', { events: { 'settings-changed': load } });

  const save = (key: string) => (value: unknown) => api.saveRepoSetting(alias, key, value).then(setData);
  return (
    <section className="wd-repo-settings" aria-label={`${alias} settings`}>
      <header className="wd-repo-settings-head">
        <h2>{alias}</h2>
        <a className="wd-link-button" href="#/repos">
          Close
        </a>
      </header>
      {error && !data && <p className="wd-setting-error">Couldn&apos;t load its settings: {error}</p>}
      {!data && !error && <p className="wd-web-muted">Loading…</p>}
      {data && (
        <>
          <dl className="wd-repo-settings-facts">
            <dt>Folder</dt>
            <dd>
              <code>{data.path}</code>
            </dd>
            <dt>Origin</dt>
            <dd>{data.origin ? <code>{data.origin}</code> : <span className="wd-web-muted">none</span>}</dd>
            <dt>Host</dt>
            <dd>{data.host ?? <span className="wd-web-muted">unknown</span>}</dd>
          </dl>

          <div className="wd-setting">
            <label className="wd-setting-label" htmlFor={`repo-${alias}-checks`}>
              Checks that count
            </label>
            <div className="wd-setting-control">
              <SettingInput
                id={`repo-${alias}-checks`}
                kind={{ type: 'list', placeholder: 'Test' }}
                value={data.requiredChecks ?? NO_CHECKS}
                onSave={save('requiredChecks')}
              />
            </div>
            <p className="wd-setting-help">
              A failed check that isn&apos;t listed doesn&apos;t make a PR red, doesn&apos;t bring it to the Inbox and isn&apos;t asked of
              Claude — it shows grey as &ldquo;not required&rdquo;. When {data.host ?? 'the host'} requires checks itself (branch
              protection, rulesets), those win and this list isn&apos;t used.{' '}
              <span className="wd-web-muted">
                {data.requiredChecks?.length ? `Now: ${data.requiredChecks.join(', ')}.` : 'Now: none listed — every check counts.'}
              </span>
            </p>
          </div>

          <div className="wd-setting">
            <label className="wd-setting-label" htmlFor={`repo-${alias}-dev`}>
              Dev server command
            </label>
            <div className="wd-setting-control">
              <SettingInput
                id={`repo-${alias}-dev`}
                kind={{ type: 'text', placeholder: 'npm run dev' }}
                value={data.devCommand}
                placeholder="npm run dev"
                onSave={save('devCommand')}
              />
            </div>
            <p className="wd-setting-help">What Start dev server runs in a session&apos;s checkout of it, with its port in $PORT.</p>
          </div>

          <div className="wd-setting">
            <label className="wd-setting-label" htmlFor={`repo-${alias}-reviews`}>
              Reviews
            </label>
            <div className="wd-setting-control">
              <SettingInput
                id={`repo-${alias}-reviews`}
                kind={{
                  type: 'choice',
                  options: [
                    { value: 'all', label: 'Every open PR' },
                    { value: 'asked', label: 'Only when you ask' },
                    { value: 'off', label: 'Off' },
                  ],
                }}
                value={data.reviews}
                onSave={save('reviews')}
              />
            </div>
            <p className="wd-setting-help">
              Whether its PRs are prepared as reviews in the background (the Reviews tab). Not set (—): as its group says, else every open
              PR.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
