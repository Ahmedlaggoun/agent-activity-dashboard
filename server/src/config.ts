// Minimal env config. No dependency on dotenv — Node 20 reads .env via
// `node --env-file`, and tsx honours process.env; we also do a tiny manual
// .env parse so `npm run dev` works without extra flags.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDotEnv(): void {
  const envPath = resolve(__dirname, '../../.env');
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // no .env — defaults apply
  }
}
loadDotEnv();

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num('PORT', 4318),
  host: process.env.HOST ?? '0.0.0.0',
  ringSize: num('RING_SIZE', 500),
  idleMs: num('IDLE_MS', 45_000),
  sessionTtlMs: num('SESSION_TTL_MS', 30 * 60_000),
  jira: {
    baseUrl: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_API_TOKEN,
  },
};

export type Config = typeof config;
