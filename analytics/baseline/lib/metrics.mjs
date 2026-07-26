// Derive DORA + cost metrics from the raw PR/ticket dataset.
// DORA uses medians/percentiles, never means (means hide tail pain).
import { median, percentile, diffMs, msToHours, msToDays, monthKey } from './util.mjs';

const bump = (obj, k, n = 1) => (obj[k] = (obj[k] || 0) + n);

export function computeMetrics(prs, tickets, costByTicket, cfg) {
  const deployments = prs.filter((p) => p.mergedToDefault); // prod = merge to default branch
  const failures = deployments.filter((p) => p.isRevert || p.isHotfix);

  // --- Deployment frequency (per month + overall/week) ---
  const deploysByMonth = {};
  for (const d of deployments) bump(deploysByMonth, monthKey(d.mergedAt));
  const months = Object.keys(deploysByMonth).length || 1;
  const deploysPerWeek = +((deployments.length / (months * 4.345)) || 0).toFixed(2);

  // --- PR cycle time ---
  const openToReview = deployments.map((p) => diffMs(p.createdAt, p.firstReviewAt));
  const reviewToMerge = deployments.map((p) => diffMs(p.firstReviewAt, p.mergedAt));
  const openToMerge = deployments.map((p) => diffMs(p.createdAt, p.mergedAt));

  // --- Lead time ticket -> production (merge-based) + Jira phase split ---
  const prByTicket = {};
  for (const p of prs) if (p.ticket && p.mergedToDefault) (prByTicket[p.ticket] ??= []).push(p);
  const leadMerge = [];
  const phaseDev = [];
  const phaseReview = [];
  const phaseValidation = [];
  const leadJira = [];
  for (const t of tickets) {
    const matched = prByTicket[t.key];
    if (matched?.length) {
      const lastMerge = matched.map((p) => p.mergedAt).sort().at(-1);
      leadMerge.push(diffMs(t.created, lastMerge));
    }
    if (t.resolvedAt) leadJira.push(diffMs(t.created, t.resolvedAt));
    if (t.timeInPhaseMs) {
      if (t.timeInPhaseMs.dev) phaseDev.push(t.timeInPhaseMs.dev);
      if (t.timeInPhaseMs.review) phaseReview.push(t.timeInPhaseMs.review);
      if (t.timeInPhaseMs.validation) phaseValidation.push(t.timeInPhaseMs.validation);
    }
  }

  // --- Change failure rate ---
  const changeFailureRate = deployments.length ? +(failures.length / deployments.length).toFixed(4) : null;
  const resolvedTickets = tickets.filter((t) => t.resolvedAt);
  const reopenRate = resolvedTickets.length
    ? +(resolvedTickets.filter((t) => t.reopenCount > 0).length / resolvedTickets.length).toFixed(4)
    : null;

  // --- Time to restore (approx): revert/hotfix merge minus the previous
  //     merge-to-default in the same repo (the change it most likely follows).
  const byRepoMerges = {};
  for (const d of deployments) (byRepoMerges[d.repo] ??= []).push(d);
  for (const list of Object.values(byRepoMerges)) list.sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt));
  const restoreMs = [];
  for (const f of failures) {
    const list = byRepoMerges[f.repo] || [];
    const idx = list.findIndex((x) => x.number === f.number);
    const prev = idx > 0 ? list[idx - 1] : null;
    if (prev) restoreMs.push(diffMs(prev.mergedAt, f.mergedAt));
  }

  // --- € per merged PR (tokens live here) ---
  const totalCost = Object.values(costByTicket || {}).reduce((a, b) => a + b, 0);
  const costPerPR = deployments.length && totalCost ? +(totalCost / deployments.length).toFixed(4) : null;
  const costPerTicket = {};
  for (const [k, v] of Object.entries(costByTicket || {})) costPerTicket[k] = +v.toFixed(4);

  // --- Code volume (TRACKED, never a success measure) ---
  const diffSizes = deployments.map((p) => p.diffSize);
  const codeVolume = {
    _warning: 'Tracked for context only. NEVER present as a productivity or success measure.',
    totalAdditions: deployments.reduce((a, p) => a + p.additions, 0),
    totalDeletions: deployments.reduce((a, p) => a + p.deletions, 0),
    medianDiffSize: median(diffSizes),
    p90DiffSize: percentile(diffSizes, 90),
  };

  return {
    window: cfg._window,
    generatedAt: cfg._generatedAt,
    counts: {
      pullRequests: prs.length,
      deploymentsToDefault: deployments.length,
      tickets: tickets.length,
      failures: failures.length,
    },
    dora: {
      leadTimeToProd: {
        note: 'ticket.created -> last PR merge to default branch',
        medianDays: msToDays(median(leadMerge)),
        p90Days: msToDays(percentile(leadMerge, 90)),
        split_medianHours: {
          dev: msToHours(median(phaseDev)),
          review: msToHours(median(phaseReview)),
          validation: msToHours(median(phaseValidation)),
        },
        jiraOnly_medianDays: msToDays(median(leadJira)),
      },
      deploymentFrequency: {
        totalDeployments: deployments.length,
        perWeek: deploysPerWeek,
        byMonth: deploysByMonth,
      },
      changeFailureRate: {
        rate: changeFailureRate,
        failures: failures.length,
        deployments: deployments.length,
        reverts: failures.filter((f) => f.isRevert).length,
        hotfixes: failures.filter((f) => f.isHotfix).length,
        jiraReopenRate: reopenRate,
      },
      timeToRestore: {
        note: 'approx: revert/hotfix merge minus previous merge-to-default (same repo). Replace with incident MTTR when available.',
        medianHours: msToHours(median(restoreMs)),
        p90Hours: msToHours(percentile(restoreMs, 90)),
        samples: restoreMs.length,
      },
    },
    cost: {
      note: 'Cost joined from the dashboard cost-ledger by ticket key. Null if no ledger present yet.',
      totalUsd: +totalCost.toFixed(4),
      perMergedPrUsd: costPerPR,
      perTicketUsd: costPerTicket,
    },
    prCycle_medianHours: {
      openToFirstReview: msToHours(median(openToReview)),
      firstReviewToMerge: msToHours(median(reviewToMerge)),
      openToMerge: msToHours(median(openToMerge)),
    },
    codeVolume,
  };
}
