import type { SessionState } from '../types';
import { ago, since, statusLabel, tokens, usd } from '../format';

export function SessionCard({
  s,
  onClick,
}: {
  s: SessionState;
  onClick: () => void;
}) {
  const ticket = s.ticket
    ? s.ticketTitle && s.ticketTitle !== s.ticket
      ? `${s.ticket} · ${s.ticketTitle}`
      : s.ticket
    : null;

  return (
    <button className={`card status-${s.status}`} onClick={onClick} title="View turn timeline">
      <div className="card-top">
        <span className={`pill pill-${s.status}`}>
          <span className="dot" />
          {statusLabel[s.status]}
          {s.status === 'tool' && s.currentTool ? `: ${s.currentTool}` : ''}
        </span>
        <span className="card-provider" data-provider={s.provider}>
          {s.provider === 'claude' ? 'Claude' : 'Codex'}
          {s.client && s.client !== 'unknown' ? ` · ${s.client}` : ''}
        </span>
        <span className="card-actor">{s.agent ?? s.userEmail ?? s.sessionId.slice(0, 8)}</span>
      </div>

      <div className="card-repo">
        {s.repo ?? <span className="muted">unknown repo</span>}
        {s.branch && <span className="branch">⎇ {s.branch}</span>}
      </div>

      {ticket ? (
        <div className="card-ticket">{ticket}</div>
      ) : (
        <div className="card-ticket muted">no ticket</div>
      )}

      <div className="card-metrics">
        <span title="Current turn duration">⏱ {s.status === 'idle' ? '—' : since(s.turnStartedAt)}</span>
        <span title="Tokens this session">◇ {tokens(s.sessionTokens)}</span>
        <span title="Cost this session">{usd(s.sessionCostUsd)}</span>
      </div>

      <div className="card-foot">
        <span>{s.promptCount} prompt{s.promptCount === 1 ? '' : 's'}</span>
        <span className="muted">{ago(s.lastEventAt)}</span>
      </div>
    </button>
  );
}
