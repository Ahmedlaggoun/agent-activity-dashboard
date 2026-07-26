// Pluggable ticket-title resolver. Default: key-only (returns the key itself).
// If JIRA_BASE_URL + credentials are configured, resolves real titles via the
// Jira REST API with an in-memory cache. Never blocks ingestion.
import { config } from './config.js';

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | undefined>>();

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export function isTicketKey(s: string | undefined): s is string {
  return !!s && KEY_RE.test(s);
}

/** Synchronous best-effort: cached title if we have it, else the bare key. */
export function cachedTitle(key: string): string {
  return cache.get(key) ?? key;
}

/** Kick off async resolution; resolves to a title (or undefined if unavailable). */
export async function resolveTitle(key: string): Promise<string | undefined> {
  if (!isTicketKey(key)) return undefined;
  if (cache.has(key)) return cache.get(key);
  const { baseUrl, email, token } = config.jira;
  if (!baseUrl || !email || !token) return undefined; // key-only mode

  if (inflight.has(key)) return inflight.get(key);
  const p = fetchTitle(key, baseUrl, email, token)
    .then((title) => {
      if (title) cache.set(key, title);
      return title;
    })
    .catch(() => undefined)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchTitle(
  key: string,
  baseUrl: string,
  email: string,
  token: string,
): Promise<string | undefined> {
  const url = `${baseUrl.replace(/\/$/, '')}/rest/api/3/issue/${key}?fields=summary`;
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { fields?: { summary?: string } };
    return data.fields?.summary;
  } finally {
    clearTimeout(t);
  }
}
