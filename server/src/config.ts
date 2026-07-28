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

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v !== '0' && v.toLowerCase() !== 'false';
}

export const config = {
  port: num('PORT', 4318),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: process.env.DATA_DIR ?? resolve(__dirname, '../data'),
  ringSize: num('RING_SIZE', 500),
  idleMs: num('IDLE_MS', 45_000),
  sessionTtlMs: num('SESSION_TTL_MS', 30 * 60_000),
  retentionDays: num('RETENTION_DAYS', 60),
  // Pseudonymize identities (default on). Off only for a single-user local run.
  anonymize: bool('ANONYMIZE', true),
  anonymizeSalt: process.env.ANONYMIZE_SALT ?? 'aad-fleet',
  // Auth: when set, ingest routes require INGEST_TOKEN and viewer routes
  // (/api, /live) require VIEWER_TOKEN. Unset = open (localhost dev).
  ingestToken: process.env.INGEST_TOKEN,
  viewerToken: process.env.VIEWER_TOKEN,
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY,
  delivery: {
    settingsPath: process.env.DELIVERY_SETTINGS_PATH ?? resolve(process.env.DATA_DIR ?? resolve(__dirname, '../data'), 'delivery/settings.json'),
    secretsPath: process.env.DELIVERY_SECRETS_PATH ?? resolve(process.env.DATA_DIR ?? resolve(__dirname, '../data'), 'delivery/secrets.json'),
    runsPath: process.env.DELIVERY_RUNS_PATH ?? resolve(process.env.DATA_DIR ?? resolve(__dirname, '../data'), 'delivery/runs.json'),
    artifactsDir: process.env.DELIVERY_ARTIFACTS_DIR ?? resolve(process.env.DATA_DIR ?? resolve(__dirname, '../data'), 'delivery/artifacts'),
    latestDoraPath: process.env.DELIVERY_LATEST_DORA_PATH ?? resolve(process.env.DATA_DIR ?? resolve(__dirname, '../data'), 'delivery/latest-success/latest-dora.json'),
    extractorPath: process.env.DELIVERY_EXTRACTOR_PATH ?? resolve(__dirname, '../../analytics/baseline/extract.mjs'),
    defaultGithubApiBaseUrl: process.env.DELIVERY_GITHUB_API_BASE_URL ?? 'https://api.github.com',
  },
  jira: {
    baseUrl: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_API_TOKEN,
  },
};

export type Config = typeof config;
