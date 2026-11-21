import { useCallback, useEffect, useState } from 'react';
import type { SessionProcessWire, SessionProcessesWire } from '../../../../core/api-types.js';
import { formatAge, formatBytes, processesLine } from '../../../../core/sessions/process-view.js';
import { fetchSessionProcesses, stopSessionProcess, type SessionSummary } from '../../api/client.js';
import { useBackdropClose } from '../../hooks/use-backdrop-close.js';
import { Button } from '../../ui/index.js';

/** What a row says of itself beside its command: the agent, or how long it has run. Pure. */
export function processNote(p: SessionProcessWire, now: number): string {
  if (p.agent) return 'its agent';
  if (p.startedAt === null) return '';
  const age = formatAge(now - p.startedAt);
  return p.leftover ? `running for ${age}` : age;
}

/**
 * ⋯ → Processes…: what the session's agent and the things it started hold in memory right now, most first — and a
 * Stop for one left running (a dev server, a watcher). Read when it opens and on Refresh: a listing takes a second.
 */
export function SessionProcesses({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const [data, setData] = useState<SessionProcessesWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState<number | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    fetchSessionProcesses(session.id).then(
      (d) => {
        setData(d);
        setError(null);
        setLoading(false);
      },
      (err: Error) => {
        setError(err.message);
        setLoading(false);
      },
    );
  }, [session.id]);
  useEffect(load, [load]);
  const stop = (p: SessionProcessWire) => {
    setStopping(p.pid);
    stopSessionProcess(session.id, p.pid, p.startedAt).then(
      (d) => {
        setData(d);
        setError(null);
        setStopping(null);
      },
      (err: Error) => {
        setError(err.message);
        setStopping(null);
      },
    );
  };
  const backdrop = useBackdropClose(onClose);
  const name = session.title && session.titleIsYours ? session.title : session.branch;

  return (
    <div
      className="wd-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Processes"
      onMouseDown={backdrop.onMouseDown}
      onClick={backdrop.onClick}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="wd-modal wd-procs">
        <header className="wd-modal-header">
          <h2>Processes of {name}</h2>
          <Button variant="quiet" icon className="wd-modal-close" onClick={onClose} aria-label="Close">
            ×
          </Button>
        </header>
        <div className="wd-modal-body">
          <p className="wd-procs-summary" role="status">
            {data ? processesLine(data) : loading ? 'Looking at what runs…' : ''}
          </p>
          {error && <p className="wd-tab-error">{error}</p>}
          {data && data.processes.length > 0 && (
            <table className="wd-procs-table">
              <tbody>
                {data.processes.map((p) => (
                  <tr key={p.pid} className={p.leftover ? 'wd-procs-leftover' : undefined}>
                    <td className="wd-procs-mem">{p.memBytes === null ? '–' : formatBytes(p.memBytes)}</td>
                    <td className="wd-procs-what" title={`${p.what} (PID ${p.pid})`}>
                      {p.what}
                    </td>
                    <td className="wd-procs-note">{processNote(p, data.at)}</td>
                    <td className="wd-procs-act">
                      {!p.agent && (
                        <Button disabled={stopping !== null} onClick={() => stop(p)}>
                          {stopping === p.pid ? 'Stopping…' : 'Stop'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="wd-procs-hint">
            Its agent and everything the agent started, plus what runs from its folder. Stopping one stops what it started too.
          </p>
        </div>
        <footer className="wd-modal-footer">
          <Button onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </footer>
      </div>
    </div>
  );
}
