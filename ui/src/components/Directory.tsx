import { useMemo } from 'react';
import type { SessionState, SessionStatus } from '../types';

export interface Selection {
  stream: string | null;
  agent: string | null;
}

const STATUS_RANK: Record<SessionStatus, number> = { tool: 0, thinking: 1, idle: 2 };

function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`dir-dot dir-dot-${status}`} />;
}

/** Left-nav directory: streams -> agents, with live status. Drives filtering. */
export function Directory({
  sessions,
  selection,
  onSelect,
}: {
  sessions: SessionState[];
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const streams = useMemo(() => {
    const byStream = new Map<string, Map<string, SessionState[]>>();
    for (const s of sessions) {
      const stream = s.teamId ?? 'unassigned';
      const agent = s.agent ?? s.sessionId.slice(0, 8);
      if (!byStream.has(stream)) byStream.set(stream, new Map());
      const agents = byStream.get(stream)!;
      (agents.get(agent) ?? agents.set(agent, []).get(agent)!).push(s);
    }
    return [...byStream.entries()]
      .map(([stream, agents]) => ({
        stream,
        agents: [...agents.entries()]
          .map(([agent, list]) => ({
            agent,
            list,
            status: list.slice().sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])[0].status,
            active: list.filter((s) => s.status !== 'idle').length,
          }))
          .sort((a, b) => a.agent.localeCompare(b.agent)),
      }))
      .sort((a, b) => a.stream.localeCompare(b.stream));
  }, [sessions]);

  const totalActive = sessions.filter((s) => s.status !== 'idle').length;

  return (
    <nav className="directory">
      <button
        className={`dir-all ${!selection.stream && !selection.agent ? 'sel' : ''}`}
        onClick={() => onSelect({ stream: null, agent: null })}
      >
        All streams <span className="dir-count">{totalActive} active</span>
      </button>

      {streams.map(({ stream, agents }) => {
        const streamSel = selection.stream === stream && !selection.agent;
        const active = agents.reduce((n, a) => n + a.active, 0);
        return (
          <div key={stream} className="dir-stream">
            <button
              className={`dir-stream-head ${streamSel ? 'sel' : ''}`}
              onClick={() => onSelect({ stream, agent: null })}
            >
              <span className="dir-stream-name">{stream}</span>
              <span className="dir-count">{active}/{agents.length}</span>
            </button>
            <div className="dir-agents">
              {agents.map(({ agent, status, list }) => (
                <button
                  key={agent}
                  className={`dir-agent ${selection.agent === agent ? 'sel' : ''}`}
                  onClick={() => onSelect({ stream, agent })}
                  title={`${list.length} session${list.length === 1 ? '' : 's'}`}
                >
                  <StatusDot status={status} />
                  <span className="dir-agent-name">{agent}</span>
                  {list.length > 1 && <span className="dir-badge">{list.length}</span>}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {sessions.length === 0 && <div className="dir-empty">No agents connected</div>}
    </nav>
  );
}
