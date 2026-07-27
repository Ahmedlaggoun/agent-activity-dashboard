import { useMemo, useState } from 'react';
import { useDashboard } from './api/ws';
import { AggregateBar } from './components/AggregateBar';
import { DoraStrip } from './components/DoraStrip';
import { SessionCard } from './components/SessionCard';
import { SessionDetail } from './components/SessionDetail';
import { Directory, type Selection } from './components/Directory';
import { AgentMap } from './components/AgentMap';
import type { SessionState } from './types';

type View = 'board' | 'map';

export default function App() {
  const { connected, sessions, aggregate, events } = useDashboard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>('board');
  const [selection, setSelection] = useState<Selection>({ stream: null, agent: null });

  // Directory filter applied to whichever view is showing.
  const filtered = useMemo(
    () =>
      sessions.filter(
        (s) =>
          (!selection.stream || (s.teamId ?? 'unassigned') === selection.stream) &&
          (!selection.agent || (s.agent ?? s.sessionId.slice(0, 8)) === selection.agent),
      ),
    [sessions, selection],
  );

  const groups = useMemo(() => {
    const map = new Map<string, SessionState[]>();
    for (const s of filtered) {
      const key = s.teamId ?? 'unassigned';
      (map.get(key) ?? map.set(key, []).get(key)!).push(s);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const selected = sessions.find((s) => s.sessionId === selectedId) ?? null;
  const scopeLabel = selection.agent ?? selection.stream ?? 'All streams';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <div className="brand-title">Agent Activity Dashboard</div>
            <div className="brand-sub">Observability of agents — build phase · anonymized</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="viewswitch">
            <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>
              Board
            </button>
            <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>
              Map
            </button>
          </div>
          <div className={`conn ${connected ? 'on' : 'off'}`}>
            <span className="dot" />
            {connected ? 'Live' : 'Reconnecting…'}
          </div>
        </div>
      </header>

      <AggregateBar agg={aggregate} />
      <DoraStrip />

      <div className="shell">
        <Directory sessions={sessions} selection={selection} onSelect={setSelection} />

        <main className="main">
          {(selection.stream || selection.agent) && (
            <div className="scopebar">
              Showing <strong>{scopeLabel}</strong>
              <button className="scope-clear" onClick={() => setSelection({ stream: null, agent: null })}>
                clear filter ✕
              </button>
            </div>
          )}

          {view === 'map' ? (
            <AgentMap sessions={filtered} onSelect={setSelectedId} />
          ) : filtered.length === 0 ? (
            <div className="empty">
              <div className="empty-title">No active agent sessions</div>
              <p className="empty-body">
                Point a Claude Code session at the dashboard (bootstrap script) — sessions appear here
                in real time, one anonymized agent per developer.
              </p>
            </div>
          ) : (
            groups.map(([stream, list]) => (
              <section key={stream} className="stream">
                <div className="stream-head">
                  <h2>{stream}</h2>
                  <span className="stream-count">
                    {list.length} session{list.length === 1 ? '' : 's'} ·{' '}
                    {list.filter((s) => s.status !== 'idle').length} active
                  </span>
                </div>
                <div className="cards">
                  {list.map((s) => (
                    <SessionCard key={s.sessionId} s={s} onClick={() => setSelectedId(s.sessionId)} />
                  ))}
                </div>
              </section>
            ))
          )}
        </main>
      </div>

      {selected && (
        <SessionDetail session={selected} events={events} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
