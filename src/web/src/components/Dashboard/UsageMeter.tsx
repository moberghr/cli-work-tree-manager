import { useCallback, useEffect, useRef, useState } from 'react';
import type { TokenTotals, UsageWire } from '../../../../core/api-types.js';
import { formatTokens } from '../../../../core/usage/usage.js';
import { fetchUsage } from '../../api/client.js';
import { useSse } from '../../api/events.js';
import { ageText, meterView, stale, windowRows } from '../../state/usage-view.js';

interface Props {
  onOpenSession: (id: string) => void;
  /** Injectable for tests. */
  load?: () => Promise<UsageWire>;
}

const sum = (t: TokenTotals) => t.input + t.cached + t.output;
function TokenRow({ label, t, muted = false }: { label: string; t: TokenTotals; muted?: boolean }) {
  return (
    <tr className={muted ? 'wd-usage-muted' : undefined}>
      <th scope="row">{label}</th>
      <td>{formatTokens(t.input)}</td>
      <td>{formatTokens(t.cached)}</td>
      <td>{formatTokens(t.output)}</td>
    </tr>
  );
}

/**
 * Plan limits and token use in the top bar: the window nearest its limit as
 * a small button (coloured from 70% and 90%), and a panel with every
 * agent's windows, the tokens work's sessions used today and this week, and
 * the sessions that used most. The limits are what the agent's status line
 * last reported (core/usage/), so the panel says how old they are.
 */
export function UsageMeter({ onOpenSession, load = fetchUsage }: Props) {
  const [data, setData] = useState<UsageWire | null>(null);
  /** Why the last fetch failed (null: it didn't). Old numbers stay on screen meanwhile. */
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const reload = useCallback(() => {
    load().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [load]);
  useEffect(reload, [reload]);
  useSse('/events', { events: { 'usage-changed': reload }, onOpen: reload });
  // The ages tick while the panel is open.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const view = meterView(data, open ? now : Date.now(), error);
  const pct = /\d+%$/.exec(view.text)?.[0];

  return (
    <div className="wd-usage" ref={ref}>
      <button
        type="button"
        className={`wd-usage-meter wd-usage-${view.level}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={view.title}
        onClick={() => setOpen((o) => !o)}
      >
        {/* Narrow top bars keep only the percent. */}
        <span className="wd-usage-long">{view.text}</span>
        {pct && <span className="wd-usage-short">{pct}</span>}
        {!pct && <span className="wd-usage-short">{view.text}</span>}
      </button>
      {open && (
        <div className="wd-usage-panel" role="dialog" data-popover aria-label="Usage">
          {error && (
            <p className="wd-usage-note wd-usage-error">
              {data ? `The last refresh failed (${error}): these are the numbers from before.` : `Usage unavailable: ${error}`}
            </p>
          )}
          {(data || !error) && <Limits data={data} now={now} />}
          {data && <Tokens data={data} onOpen={(id) => (setOpen(false), onOpenSession(id))} />}
        </div>
      )}
    </div>
  );
}

function Limits({ data, now }: { data: UsageWire | null; now: number }) {
  const agents = data?.agents ?? [];
  if (agents.length === 0) {
    return (
      <p className="wd-usage-note">
        No agent reports its plan limits. Claude Code's status line records them once a Claude session draws it.
      </p>
    );
  }
  return (
    <>
      {agents.map((a) => {
        const readings = a.accounts.filter((acc) => acc.windows.length > 0);
        return (
          <section key={a.agent}>
            <h3 className="wd-legend-title">{a.name}</h3>
            {readings.length === 0 && <p className="wd-usage-note">No reading yet — a running session's status line records it.</p>}
            {readings.map((acc) => (
              <div key={acc.account} className="wd-usage-account">
                {a.accounts.length > 1 && <div className="wd-usage-muted">account {acc.account}</div>}
                {windowRows(acc, now).map((r) => (
                  <div key={r.label} className="wd-usage-row">
                    <span className="wd-usage-label">{r.label}</span>
                    <span className="wd-usage-bar" aria-hidden>
                      <span className={`wd-usage-fill wd-usage-fill-${r.level}`} style={{ width: `${Math.min(100, r.pct)}%` }} />
                    </span>
                    <span className="wd-usage-pct">{r.pct}%</span>
                    <span className="wd-usage-muted wd-usage-reset">{r.reset}</span>
                  </div>
                ))}
                <div className={'wd-usage-muted' + (stale(acc.at, now) ? ' wd-usage-stale' : '')}>
                  {stale(acc.at, now)
                    ? `last read ${ageText(acc.at, now)} — a running Claude refreshes it`
                    : `read ${ageText(acc.at, now)}`}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}

function Tokens({ data, onOpen }: { data: UsageWire; onOpen: (id: string) => void }) {
  const { today, week, byModel, topSessions } = data.tokens;
  return (
    <section>
      <h3 className="wd-legend-title">Tokens (work's sessions)</h3>
      {/* One table, so the numbers line up: today and the week, then the week by model. */}
      <table className="wd-usage-tokens">
        <thead>
          <tr>
            <th />
            <th>in</th>
            <th>cached</th>
            <th>out</th>
          </tr>
        </thead>
        <tbody>
          <TokenRow label="Today" t={today} />
          <TokenRow label="This week" t={week} />
          {byModel
            .filter((m) => sum(m.week) > 0)
            .map((m) => (
              <TokenRow key={m.model} label={m.model} t={m.week} muted />
            ))}
        </tbody>
      </table>
      {topSessions.length > 0 && (
        <>
          <h3 className="wd-legend-title">Most this week</h3>
          <ul className="wd-usage-top">
            {topSessions.slice(0, 5).map((s) => (
              <li key={s.id}>
                <button type="button" className="wd-link-button" onClick={() => onOpen(s.id)} title="Open this session">
                  {s.label}
                </button>{' '}
                <span className="wd-usage-muted">{formatTokens(s.week.input + s.week.output)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
