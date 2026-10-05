import { useCallback, useEffect, useState } from 'react';
import type { SetupWire } from '../../../../../core/api-types.js';
import { fetchSetup, saveSetupFolders } from '../../../api/panes.js';
import { useSse } from '../../../api/events.js';
import { blockingTools } from '../../../state/setup.js';
import { ReposTab, type ReposApi } from './ReposTab.js';

interface Props {
  onNewWorktree: () => void;
  /** Done here: on to Start. */
  onDone: () => void;
  /** Test seams; default to the API. */
  load?: (fresh?: boolean) => Promise<SetupWire>;
  save?: (worktreesRoot: string, reposFolder: string) => Promise<void>;
  reposApi?: ReposApi;
}

/**
 * First run: where your repos are and where worktrees go, which repos work
 * should know, whether the tools it leans on answer, then the first
 * session. The dashboard opens here while there's nothing to work on yet
 * (state/setup.ts `needsSetup`); every step can be changed later (the Repos
 * page, `work config`).
 */
export function WelcomeTab({ onNewWorktree, onDone, load = fetchSetup, save = saveSetupFolders, reposApi }: Props) {
  const [setup, setSetup] = useState<SetupWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reposFolder, setReposFolder] = useState('');
  const [worktreesRoot, setWorktreesRoot] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(
    (fresh = false) =>
      load(fresh).then(
        (s) => {
          setSetup(s);
          setReposFolder((v) => v || s.reposFolder || s.suggested.reposFolder || '');
          setWorktreesRoot((v) => v || s.worktreesRoot || s.suggested.worktreesRoot);
        },
        (e: Error) => setError(e.message),
      ),
    [load],
  );
  useEffect(() => void refresh(), [refresh]);
  useSse('/events', { events: { 'repos-changed': () => void refresh() } });

  if (!setup) return <div className="wd-tab-empty">{error ?? 'Loading…'}</div>;
  const changed = reposFolder !== (setup.reposFolder ?? '') || worktreesRoot !== (setup.worktreesRoot ?? '');
  const blocking = blockingTools(setup);

  const saveFolders = () => {
    setSaving(true);
    setError(null);
    save(worktreesRoot.trim(), reposFolder.trim())
      .then(() => refresh())
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="wd-dash-tab-pane wd-tab-welcome">
      <header className="wd-tab-header">
        <h1>Welcome to work</h1>
      </header>
      <p className="wd-welcome-intro">
        Each piece of work gets its own git worktree and its own Claude, and this dashboard shows them all: which one needs you, what each
        changed, its pull request. Three things to set up, then start.
      </p>

      <section className="wd-welcome-step" aria-label="Folders">
        <h2 className="wd-start-title">1 · Folders {setup.configured && !changed && <span className="wd-welcome-ok">✓</span>}</h2>
        <label className="wd-welcome-field">
          <span>Your repos are in</span>
          <input value={reposFolder} onChange={(e) => setReposFolder(e.target.value)} placeholder="C:\Users\you\source\repos" />
        </label>
        <label className="wd-welcome-field">
          <span>Worktrees go in</span>
          <input value={worktreesRoot} onChange={(e) => setWorktreesRoot(e.target.value)} />
        </label>
        <p className="wd-start-note">
          One folder per piece of work goes here (a repo&apos;s folder, then the branch). It is made if it isn&apos;t there.
        </p>
        {(changed || !setup.configured) && (
          <button
            type="button"
            className="wd-btn-primary"
            disabled={saving || !reposFolder.trim() || !worktreesRoot.trim()}
            onClick={saveFolders}
          >
            {saving ? 'Saving…' : setup.configured ? 'Save folders' : 'Use these folders'}
          </button>
        )}
        {error && (
          <p className="wd-repos-error" role="alert">
            {error}
          </p>
        )}
      </section>

      {setup.configured && (
        <section className="wd-welcome-step" aria-label="Your repos">
          <h2 className="wd-start-title">2 · Your repos {setup.repos > 0 && <span className="wd-welcome-ok">✓ {setup.repos}</span>}</h2>
          <p className="wd-start-note">Add the ones you work on. The rest can stay: Ignore hides them from this list.</p>
          <ReposTab api={reposApi} />
        </section>
      )}

      <section className="wd-welcome-step" aria-label="Tools">
        <h2 className="wd-start-title">
          {setup.configured ? 3 : 2} · Tools {blocking.length === 0 && <span className="wd-welcome-ok">✓</span>}
        </h2>
        <ul className="wd-welcome-tools">
          {setup.tools.map((t) => (
            <li key={t.id} className={t.ok ? 'wd-welcome-tool-ok' : t.needed ? 'wd-welcome-tool-bad' : 'wd-welcome-tool-optional'}>
              <span className="wd-welcome-tool-mark" aria-hidden>
                {t.ok ? '✓' : t.needed ? '✗' : '–'}
              </span>
              <span className="wd-welcome-tool-name">{t.label}</span>
              <span className="wd-welcome-tool-detail">{t.detail}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="wd-link-button"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void refresh(true).finally(() => setChecking(false));
          }}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </section>

      <section className="wd-welcome-step" aria-label="Start">
        <h2 className="wd-start-title">{setup.configured ? 4 : 3} · Start</h2>
        <div className="wd-welcome-start">
          <button
            type="button"
            className="wd-btn-primary"
            disabled={setup.repos === 0 || blocking.length > 0}
            title={setup.repos === 0 ? 'Add a repo first' : blocking.length ? `Needs ${blocking.join(' and ')}` : undefined}
            onClick={onNewWorktree}
          >
            New worktree
          </button>
          <button type="button" className="wd-btn-secondary" onClick={onDone}>
            Go to Start
          </button>
        </div>
        <p className="wd-start-note">
          Coming from another computer? There, run <code>work move export &lt;folder&gt;</code>; here, stop work web and run{' '}
          <code>work move import &lt;folder&gt;</code>: your sessions, conversations and repos come along.
        </p>
      </section>
    </div>
  );
}
