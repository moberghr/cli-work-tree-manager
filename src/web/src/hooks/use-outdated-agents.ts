import { useCallback, useEffect, useState } from 'react';
import type { AgentsWire } from '../../../core/api-types.js';
import { fetchAgents, restartAgents } from '../api/panes.js';
import { useSse } from '../api/events.js';
import { restartSummary } from '../state/agent-restart-view.js';

/**
 * The agents still running a version from before their tool updated (GET /api/agents),
 * kept fresh: on load, when a restart changed something, and every five minutes (an
 * update lands without telling work). With Restart them, and how it went.
 */
export function useOutdatedAgents(api = { fetchAgents, restartAgents }) {
  const [agents, setAgents] = useState<AgentsWire | null>(null);
  const [restarting, setRestarting] = useState(false);
  // How the last restart went, for the update it was about: the next one (a new install time) starts without it.
  const [said, setSaid] = useState<{ text: string; about: string | null } | null>(null);
  const load = useCallback(() => {
    api.fetchAgents().then(setAgents, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the api is fixed for the hook's life
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, [load]);
  useSse('/events', { events: { 'agents-changed': load } });

  const restart = useCallback(() => {
    setRestarting(true);
    setSaid(null);
    const about = agents?.installedAt ?? null;
    api
      .restartAgents({ outdated: true })
      .then(
        (r) => setSaid({ text: restartSummary(r), about }),
        (err: Error) => setSaid({ text: `Couldn't restart: ${err.message}`, about }),
      )
      .finally(() => {
        setRestarting(false);
        load();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the api is fixed for the hook's life
  }, [load, agents?.installedAt]);
  const note = said && said.about === (agents?.installedAt ?? null) ? said.text : null;
  return { agents, restart, restarting, note, reload: load };
}
