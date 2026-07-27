#!/usr/bin/env node
// Baseline / DORA extractor. Read-only. Produces a FROZEN, timestamped dataset.
//
//   GITHUB_TOKEN=ghp_xxx JIRA_EMAIL=you@org JIRA_API_TOKEN=xxx \
//     node extract.mjs --config config.json
//
// Flags:
//   --config <path>     config file (default ./config.json)
//   --since  <ISO date> override start (default: monthsBack from config) — use
//                       for incremental/continuous runs (e.g. --since 2026-07-01)
//   --deep-changelog    fetch full Jira changelog per issue (slower, exact)
//   --out    <dir>      output dir (default ./out)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { listOrgRepos, extractRepoPRs } from './lib/github.mjs';
import { extractTickets } from './lib/jira.mjs';
import { computeMetrics } from './lib/metrics.mjs';
import { anonymize, toCsv } from './lib/util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const hasFlag = (name) => process.argv.includes(name);

function isoStamp() {
  // avoids Date-formatting locale surprises; UTC compact
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  const cfgPath = resolve(process.cwd(), arg('--config', resolve(__dirname, 'config.json')));
  if (!existsSync(cfgPath)) {
    console.error(`Config not found: ${cfgPath}\nCopy config.example.json -> config.json and fill it in.`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const outDir = resolve(process.cwd(), arg('--out', resolve(__dirname, 'out')));

  const ghToken = process.env.GITHUB_TOKEN;
  const jiraEmail = process.env.JIRA_EMAIL;
  const jiraToken = process.env.JIRA_API_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN env var is required (read-only PAT).');
  if (!jiraEmail || !jiraToken) throw new Error('JIRA_EMAIL and JIRA_API_TOKEN env vars are required.');
  cfg.jira.email = jiraEmail;
  cfg.jira.token = jiraToken;

  const monthsBack = cfg.window?.monthsBack ?? 24;
  const sinceIso =
    arg('--since') ??
    new Date(Date.now() - monthsBack * 30.44 * 86_400_000).toISOString();
  const salt = cfg.anonymizeSalt || 'aad-baseline';
  const anonEnabled = cfg.anonymize !== false;
  const anon = (v) => anonymize(v, salt, anonEnabled);

  console.error(`\nBaseline extraction — since ${sinceIso.slice(0, 10)} (${monthsBack}m)`);
  console.error(`GitHub org: ${cfg.github.org} | Jira: ${cfg.jira.baseUrl} projects=${cfg.jira.projectKeys.join(',')}`);

  // --- GitHub ---
  let repos = cfg.github.repos?.length ? cfg.github.repos : null;
  if (!repos) {
    console.error('Listing org repos…');
    repos = await listOrgRepos(cfg.github, ghToken);
  }
  console.error(`Repos: ${repos.length}`);
  const allPRs = [];
  const defaultBranches = {};
  for (const repo of repos) {
    process.stderr.write(`  ${repo} …`);
    try {
      const { defaultBranch, prs } = await extractRepoPRs(
        cfg.github, ghToken, repo, sinceIso, cfg.failure || {}, cfg.jira.projectKeys, anon,
      );
      defaultBranches[repo] = defaultBranch;
      allPRs.push(...prs);
      process.stderr.write(` ${prs.length} PRs\n`);
    } catch (e) {
      process.stderr.write(` ERROR ${e.message}\n`);
    }
  }

  // --- Jira ---
  console.error('Extracting Jira tickets…');
  const tickets = await extractTickets(cfg.jira, sinceIso, anon, { deepChangelog: hasFlag('--deep-changelog') });
  console.error(`Tickets: ${tickets.length}`);

  // --- Cost ledger (tokens -> €) ---
  const ledgerPath = resolve(__dirname, cfg.costLedgerPath || '../../server/data/cost-ledger.jsonl');
  const costByTicket = {};
  if (existsSync(ledgerPath)) {
    for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.ticket && r.dUsd) costByTicket[r.ticket] = (costByTicket[r.ticket] || 0) + r.dUsd;
      } catch {}
    }
    console.error(`Cost ledger: ${Object.keys(costByTicket).length} tickets with cost`);
  } else {
    console.error('Cost ledger not found (fine — €/PR will be null until the dashboard runs).');
  }

  // --- Compute + freeze ---
  cfg._window = { since: sinceIso, monthsBack };
  cfg._generatedAt = new Date().toISOString();
  const metrics = computeMetrics(allPRs, tickets, costByTicket, cfg);

  const stamp = isoStamp();
  const configHash = createHash('sha256').update(JSON.stringify({ ...cfg, jira: { ...cfg.jira, token: null } })).digest('hex').slice(0, 12);
  const manifest = {
    kind: 'agent-activity-baseline',
    frozenAt: cfg._generatedAt,
    window: cfg._window,
    org: cfg.github.org,
    jiraProjects: cfg.jira.projectKeys,
    repos,
    defaultBranches,
    anonymized: anonEnabled,
    configHash,
    counts: metrics.counts,
  };

  writeFileSync(resolve(outDir, `baseline-raw-${stamp}.json`), JSON.stringify({ manifest, prs: allPRs, tickets }, null, 2));
  writeFileSync(resolve(outDir, `baseline-dora-${stamp}.json`), JSON.stringify({ manifest, metrics }, null, 2));
  writeFileSync(resolve(outDir, `baseline-prs-${stamp}.csv`), toCsv(allPRs.map((p) => ({ ...p, labels: (p.labels || []).join('|') }))));
  writeFileSync(
    resolve(outDir, `baseline-tickets-${stamp}.csv`),
    toCsv(tickets.map((t) => ({
      key: t.key, type: t.type, status: t.status, created: t.created, resolvedAt: t.resolvedAt,
      reopenCount: t.reopenCount,
      devMs: t.timeInPhaseMs?.dev, reviewMs: t.timeInPhaseMs?.review, validationMs: t.timeInPhaseMs?.validation,
    }))),
  );
  // also refresh a stable pointer the dashboard reads for the live DORA strip
  writeFileSync(resolve(outDir, `latest-dora.json`), JSON.stringify({ manifest, metrics }, null, 2));

  console.error(`\nFROZEN → ${outDir}`);
  console.error(`  baseline-dora-${stamp}.json  (metrics)`);
  console.error(`  baseline-raw-${stamp}.json   (raw, anonymized)`);
  console.error(`  baseline-prs / tickets .csv`);
  console.error('\n=== DORA SUMMARY ===');
  console.error(JSON.stringify(metrics.dora, null, 2));
}

main().catch((e) => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
