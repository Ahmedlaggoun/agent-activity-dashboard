# Metric set — definitions, sources, cadence

The measurement contract for the POC. Two horizons:

- **Baseline** — a *frozen* 24-month snapshot, extracted **once, this week, before AI
  changes anything** (`baseline/extract.mjs`). It is the "before" picture. Freeze it,
  commit the manifest, never overwrite it.
- **Continuous** — the same metrics tracked over the POC (re-run the extractor
  incrementally with `--since`, and read live cost from the dashboard). The "after".

> **Golden rule on measurement.** DORA metrics use **medians and p90**, never means —
> means hide the tail where the pain lives. And **code volume is tracked but is never a
> success measure** (see the last section). Optimising a volume metric is how you get
> more code and less value.

---

## The five headline metrics

### 1. Lead time for changes — ticket → production
- **Definition:** median time from ticket created to the change reaching production.
- **Production signal (agreed):** a PR **merged to the default branch**.
- **Source:** Jira ticket `created` → last merge-to-default of the PR(s) carrying the
  ticket key (matched by branch name / PR title). A Jira-only variant (created →
  first terminal/Done status) is also emitted as a cross-check.
- **Split (dev / review / validation):** from the Jira status changelog — time in
  `devStatuses` / `reviewStatuses` / `validationStatuses` (configured per board).
  This split is what tells you *where* AI helps and where it doesn't.
- **Reported as:** median days + p90 days; split as median hours per phase.

### 2. Deployment frequency
- **Definition:** how often changes reach production.
- **Source:** count of PRs merged to the default branch, per month; normalized to
  per-week.
- **Reported as:** total, per-week rate, monthly series.

### 3. Change failure rate
- **Definition:** share of production changes that cause a failure needing remediation.
- **Numerator:** merges to default that are **reverts** (title/branch `revert…`) **or
  hotfixes** (branch `hotfix/*` / `incident/*`, or a hotfix/incident label).
- **Denominator:** all merges to default.
- **Secondary signal:** Jira **reopen rate** (tickets reopened after Done) and
  incident/bug tickets linked to a release.
- **Reported as:** rate + revert/hotfix breakdown + Jira reopen rate.

### 4. Time to restore service (MTTR)
- **Definition:** median time to recover from a failed change.
- **Best source:** incident tracker (incident start → resolved) — plug in when
  available (`failure.incidentProjectKeys`).
- **POC approximation:** time from a failed change to the revert/hotfix that follows
  it in the same repo. Clearly labelled as an approximation in the output.
- **Reported as:** median hours + p90.

### 5. € per merged PR — *this is where tokens belong*
- **Definition:** agent spend attributed to delivered work.
- **Mechanism:** the dashboard writes a **cost ledger** (`server/data/cost-ledger.jsonl`):
  one line per cost delta `{ts, ticket, repo, teamId, dUsd}`, keyed by the ticket the
  session is working (from the hook's branch → ticket parse). The collector sums cost
  per ticket, then joins to merged PRs by ticket key.
- **Formula:** `€/PR = total agent cost over the window ÷ merged-to-default PRs`.
  Also emitted: **€ per ticket**.
- **Why not € per line or per token:** those reward volume. € per *delivered PR* ties
  spend to outcomes, and pairs naturally with lead time and change-failure rate.
- **Caveat:** cost only attributes where a ticket is known (hooks installed + branch
  carries the key). Sessions without a ticket are counted in "cost today" but not in
  €/PR — surfaced, never silently dropped.

---

## Data sources at a glance

| Metric | GitHub | Jira | Dashboard (OTel + hooks) |
|---|---|---|---|
| Lead time + split | merge-to-default | created, status changelog | — |
| Deployment frequency | merge-to-default | — | — |
| Change failure rate | revert/hotfix merges | reopen, linked bugs | — |
| Time to restore | revert/hotfix timing | incident tickets | — |
| € per merged PR | merged PRs | ticket keys | **cost ledger (tokens → €)** |
| Code volume (context only) | additions/deletions/files | — | — |

## Cadence

- **Baseline:** once, now. `node extract.mjs --config config.json` → freeze `out/`.
- **Continuous:** re-run incrementally, e.g. nightly:
  `node extract.mjs --config config.json --since <last-run-date>`. It refreshes
  `out/latest-dora.json`, which the dashboard serves at `GET /api/dora`.
- **Retention:** frozen baseline kept indefinitely (it's the reference). Rolling
  operational data honours the 30-day cap noted for the dashboard.

## Code volume — tracked, never scored

Lines added/deleted, files changed, PR size are **collected for context only**
(e.g. "did AI change diff size?") and are explicitly flagged `_warning: never a success
measure` in the output. Reasons:

- More code is a **cost**, not an achievement. AI makes it cheap to produce volume;
  rewarding volume optimises for exactly the wrong thing.
- Value shows up in the five metrics above (faster lead time, stable failure rate,
  lower €/PR) — not in how much code was written.

Never put a lines-of-code or tokens-burned number on a leaderboard, per developer or
per stream. The dashboard's default aggregation is by stream and non-nominative for the
same reason (see the RH/RGPD note in the root README).
