// Jira Cloud extraction. Read-only: needs an API token (email + token, Basic
// auth). Uses the current /search/jql endpoint with nextPageToken pagination and
// expand=changelog; falls back to a per-issue changelog fetch when a changelog
// is missing/truncated. Computes time-in-status, phase split, and reopen count.
import { apiFetch, anonymize, diffMs } from './util.mjs';

function auth(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
}
const headers = (cfg) => ({ authorization: auth(cfg), accept: 'application/json', 'content-type': 'application/json' });

/** Search issues updated within the window, newest changelog expanded. */
export async function searchIssues(cfg, sinceIso) {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const jql = `project in (${cfg.projectKeys.join(',')}) AND created >= "${sinceIso.slice(0, 10)}" ORDER BY created DESC`;
  const fields = ['status', 'created', 'resolutiondate', 'issuetype', 'labels', 'summary', 'assignee', 'reporter'];
  const issues = [];
  let nextPageToken;
  do {
    const body = { jql, maxResults: 100, fields, expand: ['changelog'] };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await apiFetch(
      `${base}/rest/api/3/search/jql`,
      { method: 'POST', headers: headers(cfg), body: JSON.stringify(body) },
      { label: 'jira-search' },
    );
    for (const it of data.issues ?? []) issues.push(it);
    nextPageToken = data.isLast ? undefined : data.nextPageToken;
    process.stderr.write(`  [jira] ${issues.length} issues…\r`);
  } while (nextPageToken);
  process.stderr.write('\n');
  return issues;
}

async function fetchChangelog(cfg, key) {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const out = [];
  let startAt = 0;
  for (;;) {
    const data = await apiFetch(
      `${base}/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=100`,
      { headers: headers(cfg) },
      { label: `jira-changelog-${key}` },
    );
    out.push(...(data.values ?? []));
    if (data.isLast || out.length >= (data.total ?? out.length)) break;
    startAt += data.maxResults ?? 100;
  }
  return out;
}

// Map a raw status name to a phase using config lists.
function phaseOf(status, cfg) {
  const s = (status || '').toLowerCase();
  const inList = (list) => (list || []).some((x) => x.toLowerCase() === s);
  if (inList(cfg.devStatuses)) return 'dev';
  if (inList(cfg.reviewStatuses)) return 'review';
  if (inList(cfg.validationStatuses)) return 'validation';
  if (inList(cfg.doneStatuses)) return 'done';
  return 'other';
}
const isDone = (status, cfg) => (cfg.doneStatuses || []).some((x) => x.toLowerCase() === (status || '').toLowerCase());

/**
 * Walk status transitions in chronological order; accumulate time in each
 * status and phase, and count reopens (a transition out of a done status).
 */
function analyzeHistories(created, histories, cfg) {
  // Flatten status changes: {at, from, to}
  const changes = [];
  for (const h of histories) {
    for (const item of h.items ?? []) {
      if (item.field === 'status') changes.push({ at: h.created, from: item.fromString, to: item.toString });
    }
  }
  changes.sort((a, b) => new Date(a.at) - new Date(b.at));

  const timeInStatus = {};
  const timeInPhase = { dev: 0, review: 0, validation: 0, done: 0, other: 0 };
  let reopenCount = 0;
  let cursorStatus = changes[0]?.from ?? null; // status at creation
  let cursorAt = created;

  const add = (status, from, to) => {
    const ms = diffMs(from, to);
    if (ms == null || ms < 0 || !status) return;
    timeInStatus[status] = (timeInStatus[status] || 0) + ms;
    timeInPhase[phaseOf(status, cfg)] += ms;
  };

  for (const c of changes) {
    add(cursorStatus, cursorAt, c.at);
    if (isDone(c.from, cfg) && !isDone(c.to, cfg)) reopenCount++;
    cursorStatus = c.to;
    cursorAt = c.at;
  }
  // trailing time in the final status, up to now
  add(cursorStatus, cursorAt, new Date().toISOString());

  return { timeInStatus, timeInPhase, reopenCount, firstReviewAt: firstEnter(changes, cfg, 'review'), firstDoneAt: firstEnter(changes, cfg, 'done') };
}

function firstEnter(changes, cfg, phase) {
  for (const c of changes) if (phaseOf(c.to, cfg) === phase) return c.at;
  return null;
}

export async function extractTickets(cfg, sinceIso, anon, { deepChangelog = false } = {}) {
  const issues = await searchIssues(cfg, sinceIso);
  const tickets = [];
  for (const it of issues) {
    let histories = it.changelog?.histories ?? [];
    const total = it.changelog?.total ?? histories.length;
    if (deepChangelog || total > histories.length) {
      histories = await fetchChangelog(cfg, it.key);
    }
    const created = it.fields.created;
    const a = analyzeHistories(created, histories, cfg);
    tickets.push({
      key: it.key,
      type: it.fields.issuetype?.name,
      status: it.fields.status?.name,
      created,
      resolvedAt: it.fields.resolutiondate ?? a.firstDoneAt,
      firstReviewAt: a.firstReviewAt,
      reopenCount: a.reopenCount,
      labels: it.fields.labels ?? [],
      assignee: anon(it.fields.assignee?.accountId),
      reporter: anon(it.fields.reporter?.accountId),
      timeInStatusMs: a.timeInStatus,
      timeInPhaseMs: a.timeInPhase,
    });
  }
  return tickets;
}
