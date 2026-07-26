// Shared helpers: resilient fetch (rate-limit aware), anonymization, CSV.
import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with retry on 429/403-secondary-limit/5xx, honouring Retry-After and
 * GitHub's x-ratelimit-reset. Returns parsed JSON.
 */
export async function apiFetch(url, opts = {}, { retries = 6, label = '' } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();

    const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      const body = await res.text().catch(() => '');
      throw new Error(`${label || url} -> ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    }
    // Work out how long to wait.
    let waitMs = 1000 * 2 ** attempt;
    const retryAfter = res.headers.get('retry-after');
    const rlReset = res.headers.get('x-ratelimit-reset');
    const rlRemaining = res.headers.get('x-ratelimit-remaining');
    if (retryAfter) waitMs = Number(retryAfter) * 1000;
    else if (rlRemaining === '0' && rlReset) waitMs = Math.max(0, Number(rlReset) * 1000 - Date.now()) + 1000;
    process.stderr.write(`  [rate-limit] ${label} ${res.status}; waiting ${Math.round(waitMs / 1000)}s\n`);
    await sleep(Math.min(waitMs, 120_000));
  }
}

/** Deterministic short pseudonym so team aggregation works without raw identity. */
export function anonymize(value, salt, enabled = true) {
  if (!value) return null;
  if (!enabled) return value;
  const h = createHash('sha256').update(salt + '|' + value).digest('hex').slice(0, 10);
  return `anon_${h}`;
}

/** ms between two ISO timestamps (or null). */
export function diffMs(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  return new Date(toIso).getTime() - new Date(fromIso).getTime();
}

export function median(nums) {
  const a = nums.filter((n) => n != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function percentile(nums, p) {
  const a = nums.filter((n) => n != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.floor((p / 100) * a.length));
  return a[idx];
}

export const msToHours = (ms) => (ms == null ? null : +(ms / 3_600_000).toFixed(2));
export const msToDays = (ms) => (ms == null ? null : +(ms / 86_400_000).toFixed(2));

export function monthKey(iso) {
  return iso ? iso.slice(0, 7) : 'unknown'; // YYYY-MM
}

/** Rows: array of flat objects. Returns CSV string with a header from all keys. */
export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
