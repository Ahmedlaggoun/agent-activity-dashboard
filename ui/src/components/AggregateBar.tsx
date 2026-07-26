import type { Aggregate } from '../types';
import { ago, usd } from '../format';

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="stat">
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function AggregateBar({ agg }: { agg: Aggregate | null }) {
  if (!agg) return <div className="aggbar aggbar-empty">Waiting for telemetry…</div>;

  const total = agg.editWriteAccepts + agg.editWriteRejects;
  const acceptRate = total ? Math.round((agg.editWriteAccepts / total) * 100) : null;

  return (
    <div className="aggbar">
      <Stat label="Active sessions" value={String(agg.activeSessions)} tone="accent" />
      <Stat label="Prompts / last hour" value={String(agg.promptsLastHour)} />
      <Stat label="Cost today" value={usd(agg.costTodayUsd)} tone="accent" />
      <Stat
        label="Edit/Write accept"
        value={acceptRate === null ? '—' : `${acceptRate}%`}
        tone={acceptRate !== null && acceptRate < 60 ? 'warn' : ''}
      />
      <div className="stat errors">
        <div className={`stat-value ${agg.recentErrors.length ? 'bad' : ''}`}>
          {agg.recentErrors.length}
        </div>
        <div className="stat-label">Recent API errors</div>
        {agg.recentErrors.length > 0 && (
          <div className="error-list">
            {agg.recentErrors
              .slice(-3)
              .reverse()
              .map((e, i) => (
                <span key={i} className="error-chip">
                  {e.statusCode ?? 'err'} · {ago(e.ts)}
                </span>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
