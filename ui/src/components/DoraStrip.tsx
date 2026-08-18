import { useEffect, useState } from 'react';
import { apiFetch } from '../api/ws';
import { DORA_REFRESH_EVENT } from './DeliveryDataPanel';

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
export function DoraStrip({ onOpenDeliveryData }: { onOpenDeliveryData: () => void }) {
  const [d, setD] = useState<Dora | null>(null);
  const [absent, setAbsent] = useState(false);

  useEffect(() => {
    const load = () =>
      apiFetch('/api/dora')
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((payload) => {
          setD(payload);
          setAbsent(false);
        })
        .catch(() => setAbsent(true));
    load();
    const t = setInterval(load, 60_000);
    window.addEventListener(DORA_REFRESH_EVENT, load);
    return () => {
      clearInterval(t);
      window.removeEventListener(DORA_REFRESH_EVENT, load);
    };
  }, []);

  if (absent && !d)
    return (
      <div className="dora dora-empty">
        <div>
          <div className="dora-empty-title">Delivery baseline not connected</div>
          <button type="button" className="dora-manage-button" onClick={onOpenDeliveryData}>
            Connect delivery data
          </button>
        </div>
        <div className="dora-empty-body">
          <strong>DORA</strong> measures delivery speed and stability: deployment frequency,
          lead time, change failure rate, and recovery time. <strong>Cost per merged PR</strong>{' '}
          estimates AI usage cost for each delivered pull request. Connect the GitHub and Jira
          baseline, pick the baseline date, and import the history to show these comparisons.
        </div>
      </div>
    );
  if (!d?.metrics?.dora) return null;

  const m = d.metrics.dora;
  const cfr = m.changeFailureRate?.rate;
  return (
    <div className="dora">
      <div className="dora-title">
        <span>
          DORA &amp; cost
          <span className="dora-since">
            {d.manifest?.window?.since ? `since ${d.manifest.window.since.slice(0, 10)}` : ''}
          </span>
        </span>
        <button type="button" className="dora-manage-button" onClick={onOpenDeliveryData}>
          Delivery data
        </button>
      </div>
      <div className="dora-grid">
        <Cell label="Lead time to prod" value={m.leadTimeToProd?.medianDays != null ? `${m.leadTimeToProd.medianDays}d` : '—'} sub="median" />
        <Cell label="Deploys / week" value={m.deploymentFrequency?.perWeek != null ? String(m.deploymentFrequency.perWeek) : '—'} />
        <Cell label="Change failure rate" value={cfr != null ? `${Math.round(cfr * 100)}%` : '—'} />
        <Cell label="Time to restore" value={m.timeToRestore?.medianHours != null ? `${m.timeToRestore.medianHours}h` : '—'} sub="median" />
        <Cell label="AI cost / merged PR" value={d.metrics.cost?.perMergedPrUsd != null ? `$${d.metrics.cost.perMergedPrUsd}` : '—'} sub="estimated delivery cost" />
      </div>
    </div>
  );
}
