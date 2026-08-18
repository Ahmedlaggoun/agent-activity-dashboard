import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api/ws';
import { tokens, usd } from '../format';

interface Day {
  day: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  prompts: number;
  sessions: number;
}
interface TrendsData {
  enabled: boolean;
  days: Day[];
  byStream: Array<{ teamId: string; costUsd: number; tokens: number }>;
}

const WIDTH = 720;
const HEIGHT = 160;
const PAD = { l: 8, r: 8, t: 10, b: 22 };

export function Trends() {
  const [d, setD] = useState<TrendsData | null>(null);

  useEffect(() => {
    const load = () =>
      apiFetch('/api/trends?days=14')
        .then((r) => r.json())
        .then(setD)
        .catch(() => setD({ enabled: false, days: [], byStream: [] }));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const totals = useMemo(() => {
    const days = d?.days ?? [];
    return {
      cost: days.reduce((a, x) => a + x.costUsd, 0),
      tokens: days.reduce((a, x) => a + x.tokensIn + x.tokensOut, 0),
      prompts: days.reduce((a, x) => a + x.prompts, 0),
      sessions: days.reduce((a, x) => a + x.sessions, 0),
    };
  }, [d]);

  if (d && !d.enabled)
    return (
      <div className="trends-empty">
        History persistence is not enabled on this server (SQLite unavailable). Trends appear once
        the server persists events.
      </div>
    );
  if (!d) return <div className="trends-empty">Loading trends…</div>;

  const days = d.days;
  const maxCost = Math.max(0.0001, ...days.map((x) => x.costUsd));
  const bw = (WIDTH - PAD.l - PAD.r) / days.length;
  const chartH = HEIGHT - PAD.t - PAD.b;
  const maxStreamCost = Math.max(0.0001, ...d.byStream.map((s) => s.costUsd));

  return (
    <div className="trends">
      <div className="trends-tiles">
        <Tile label="Cost · 14d" value={usd(totals.cost)} accent />
        <Tile label="Tokens · 14d" value={tokens(totals.tokens)} />
        <Tile label="Prompts · 14d" value={String(totals.prompts)} />
        <Tile label="Sessions · 14d" value={String(totals.sessions)} />
      </div>

      <div className="trends-chart-card">
        <div className="trends-chart-title">Cost per day</div>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="trends-svg" role="img" aria-label="Cost per day">
          {days.map((x, i) => {
            const h = (x.costUsd / maxCost) * chartH;
            const bx = PAD.l + i * bw;
            const by = PAD.t + (chartH - h);
            const showLabel = i % 2 === 0 || i === days.length - 1;
            return (
              <g key={x.day}>
                <rect
                  x={bx + 2}
                  y={by}
                  width={bw - 4}
                  height={Math.max(0, h)}
                  rx={3}
                  className="trends-bar"
                >
                  <title>{`${x.day}: ${usd(x.costUsd)} · ${x.prompts} prompts · ${x.sessions} sessions`}</title>
                </rect>
                {showLabel && (
                  <text x={bx + bw / 2} y={HEIGHT - 6} textAnchor="middle" className="trends-axis">
                    {x.day.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="trends-chart-card">
        <div className="trends-chart-title">Cost by stream · 14d</div>
        {d.byStream.length === 0 && <div className="trends-empty-inline">No data yet.</div>}
        {d.byStream.map((s) => (
          <div key={s.teamId} className="trends-stream-row">
            <span className="trends-stream-name">{s.teamId}</span>
            <div className="trends-stream-bar">
              <div className="trends-stream-fill" style={{ width: `${(s.costUsd / maxStreamCost) * 100}%` }} />
            </div>
            <span className="trends-stream-val">{usd(s.costUsd)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="trends-tile">
      <div className={`trends-tile-value ${accent ? 'accent' : ''}`}>{value}</div>
      <div className="trends-tile-label">{label}</div>
    </div>
  );
}
