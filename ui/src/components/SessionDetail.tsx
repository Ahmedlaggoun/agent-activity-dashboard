import { useMemo } from 'react';
import type { AgentEvent, SessionState } from '../types';
import { clock, duration, since, statusLabel, tokens, usd } from '../format';

function rowLabel(e: AgentEvent): string {
  switch (e.kind) {
    case 'user_prompt':
      return 'Prompt submitted';
    case 'tool_result':
      return `Tool · ${e.toolName ?? '?'}`;
    case 'tool_decision':
      return `Decision · ${e.toolName ?? '?'} → ${e.decision ?? '?'}`;
    case 'api_request':
      return `LLM · ${e.model ?? 'request'}`;
    case 'api_error':
      return `API error · ${e.statusCode ?? ''}`;
    case 'mcp_connection':
      return `MCP · ${e.mcpServer ?? ''} ${e.mcpState ?? ''}`;
    case 'metric':
      return `metric · ${e.metricName ?? ''}`;
    case 'activity':
      return `hook · ${e.subtype ?? ''}${e.toolName ? ` (${e.toolName})` : ''}`;
  }
}

function rowMeta(e: AgentEvent): string {
  const bits: string[] = [];
  if (e.durationMs != null) bits.push(duration(e.durationMs));
  if (e.inputTokens || e.outputTokens) bits.push(`◇ ${tokens((e.inputTokens ?? 0) + (e.outputTokens ?? 0))}`);
  if (e.costUsd) bits.push(usd(e.costUsd));
  return bits.join(' · ');
}

export function SessionDetail({
  session,
  events,
  onClose,
}: {
  session: SessionState;
  events: AgentEvent[];
  onClose: () => void;
}) {
  const timeline = useMemo(() => {
    const byPrompt = session.currentPromptId
      ? events.filter((e) => e.promptId === session.currentPromptId)
      : [];
    // Fallback (hooks-only, no prompt.id): last events for this session.
    const list = byPrompt.length
      ? byPrompt
      : events.filter((e) => e.sessionId === session.sessionId).slice(-40);
    return [...list].reverse();
  }, [events, session]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer">
        <header className="drawer-head">
          <div>
            <div className="drawer-title">{session.repo ?? session.sessionId.slice(0, 12)}</div>
            <div className="drawer-sub">
              {session.agent ?? session.userEmail ?? '—'} · {session.teamId ?? 'no stream'}
              {session.ticket ? ` · ${session.ticket}` : ''}
            </div>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="drawer-summary">
          <div>
            <span className={`pill pill-${session.status}`}>
              <span className="dot" />
              {statusLabel[session.status]}
              {session.status === 'tool' && session.currentTool ? `: ${session.currentTool}` : ''}
            </span>
          </div>
          <div className="drawer-summary-grid">
            <span>⏱ {session.status === 'idle' ? '—' : since(session.turnStartedAt)}</span>
            <span>◇ {tokens(session.sessionTokens)} tok</span>
            <span>{usd(session.sessionCostUsd)} session</span>
          </div>
        </div>

        <div className="drawer-timeline">
          <div className="timeline-head">Current turn timeline</div>
          {timeline.length === 0 && <div className="muted timeline-empty">No events yet for this turn.</div>}
          {timeline.map((e) => (
            <div key={e.id} className={`tl-row tl-${e.kind} ${e.success === false ? 'tl-fail' : ''}`}>
              <span className="tl-time">{clock(e.ts)}</span>
              <span className="tl-label">{rowLabel(e)}</span>
              <span className="tl-meta">{rowMeta(e)}</span>
              {e.kind === 'tool_result' && (
                <span className={`tl-badge ${e.success ? 'ok' : 'fail'}`}>
                  {e.success ? '✓' : '✕'}
                </span>
              )}
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
