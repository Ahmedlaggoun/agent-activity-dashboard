import { useMemo, useState } from 'react';
import { useDashboard } from './api/ws';
import { AggregateBar } from './components/AggregateBar';
import { DoraStrip } from './components/DoraStrip';
import { SessionCard } from './components/SessionCard';
import { SessionDetail } from './components/SessionDetail';
import type { SessionState } from './types';

export default function App() {
  const { connected, sessions, aggregate, events } = useDashboard();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default view: grouped by stream (team.id), not nominative.
  const groups = useMemo(() => {
    const map = new Map<string, SessionState[]>();
    for (const s of sessions) {
      const key = s.teamId ?? 'unassigned';
      (map.get(key) ?? map.set(key, []).get(key)!).push(s);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sessions]);

  const selected = sessions.find((s) => s.sessionId === selectedId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <div className="brand-title">Agent Activity Dashboard</div>
            <div className="brand-sub">Observability of agents — build phase · POC</div>
          </div>
        </div>
        <div className={`conn ${connected ? 'on' : 'off'}`}>
          <span className="dot" />
          {connected ? 'Live' : 'Reconnecting…'}
        </div>
      </header>

      <AggregateBar agg={aggregate} />
      <DoraStrip />

      <main className="board">
        {sessions.length === 0 && (
          <div className="empty">
            <div className="empty-title">No active agent sessions</div>
            <p className="empty-body">
              Start a Claude Code session with <code>source ./otel-env.sh</code> and install the
              hooks. Sessions appear here in real time.
            </p>
          </div>
        )}

        {groups.map(([stream, list]) => (
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
        ))}
      </main>

      {selected && (
        <SessionDetail session={selected} events={events} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
