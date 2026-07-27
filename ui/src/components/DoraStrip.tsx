import { useEffect, useState } from 'react';
import { apiUrl } from '../api/ws';

interface Dora {
  metrics?: {
    dora?: {
      leadTimeToProd?: { medianDays?: number | null };
      deploymentFrequency?: { perWeek?: number };
      changeFailureRate?: { rate?: number | null };
      timeToRestore?: { medianHours?: number | null };
    };
    cost?: { perMergedPrUsd?: number | null };
  };
  manifest?: { frozenAt?: string; window?: { since?: string } };
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="dora-cell">
      <div className="dora-value">{value}</div>
      <div className="dora-label">{label}</div>
      {sub && <div className="dora-sub">{sub}</div>}
    </div>
  );
}

/** Reads /api/dora; renders the 4 DORA metrics + €/PR when a collector run exists. */
export function DoraStrip() {
  const [d, setD] = useState<Dora | null>(null);
  const [absent, setAbsent] = useState(false);

  useEffect(() => {
    const load = () =>
      fetch(apiUrl('/api/dora'))
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then(setD)
        .catch(() => setAbsent(true));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (absent && !d)
    return (
      <div className="dora dora-empty">
        DORA &amp; €/PR — run <code>analytics/baseline/extract.mjs</code> to populate the baseline.
      </div>
    );
  if (!d?.metrics?.dora) return null;

  const m = d.metrics.dora;
  const cfr = m.changeFailureRate?.rate;
  return (
    <div className="dora">
      <div className="dora-title">
        DORA &amp; cost
        <span className="dora-since">
          {d.manifest?.window?.since ? `since ${d.manifest.window.since.slice(0, 10)}` : ''}
        </span>
      </div>
      <div className="dora-grid">
        <Cell label="Lead time to prod" value={m.leadTimeToProd?.medianDays != null ? `${m.leadTimeToProd.medianDays}d` : '—'} sub="median" />
        <Cell label="Deploys / week" value={m.deploymentFrequency?.perWeek != null ? String(m.deploymentFrequency.perWeek) : '—'} />
        <Cell label="Change failure rate" value={cfr != null ? `${Math.round(cfr * 100)}%` : '—'} />
        <Cell label="Time to restore" value={m.timeToRestore?.medianHours != null ? `${m.timeToRestore.medianHours}h` : '—'} sub="median" />
        <Cell label="€ / merged PR" value={d.metrics.cost?.perMergedPrUsd != null ? `$${d.metrics.cost.perMergedPrUsd}` : '—'} sub="tokens" />
      </div>
    </div>
  );
}
