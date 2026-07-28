import { gunzipSync } from 'node:zlib';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { Store } from './store/store.js';
import { parseLogs, parseMetrics } from './otlp/parse.js';
import { registerWebSocket } from './ws.js';
import { history } from './db.js';
import { cachedTitle, isTicketKey, resolveTitle } from './jira.js';
import type { ActivitySubtype, AgentEvent } from './types.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 16 * 1024 * 1024 });
const store = new Store();
let activitySeq = 0;
const nextActivityId = (suffix: string) =>
  `${Date.now().toString(36)}-${(++activitySeq).toString(36)}-${suffix}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
// Append-only cost ledger: joins tokens -> € per ticket, consumed by the
// baseline/DORA collector to compute € per merged PR. Disable with COST_LEDGER=0.
const LEDGER_PATH = resolve(__dirname, '../data/cost-ledger.jsonl');
const DORA_PATH = resolve(__dirname, '../../analytics/baseline/out/latest-dora.json');
if (process.env.COST_LEDGER !== '0') {
  store.on('usage', (rec) => {
    if (!rec.ticket || !rec.dUsd) return; // ledger joins cost -> PR by ticket
    appendFile(LEDGER_PATH, JSON.stringify({
      ts: rec.ts,
      sessionId: rec.sessionId,
      provider: rec.provider,
      client: rec.client,
      ticket: rec.ticket,
      repo: rec.repo,
      teamId: rec.teamId,
      dUsd: rec.dUsd,
    }) + '\n').catch((err) =>
      app.log.warn({ err: String(err) }, 'cost-ledger append failed'),
    );
  });
}

// --- Persistence: history + trends (SQLite; degrades to memory-only) ---
await history.init();
if (history.enabled) {
  store.restoreCumulative(history.loadCumulative());
  store.hydrateToday(history.todayTotals());
  store.on('event', (e) => history.recordEvent(e));
  store.on('usage', (u) => history.recordUsage(u));
  store.on('cumulative', (c) => history.recordCumulative(c.sessionId, c.cost, c.tokens, c.ts));
  app.log.info('history persistence enabled');
}

// --- CORS (local POC: allow the Vite dev origin) ---
app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'content-type,content-encoding');
  if (req.method === 'OPTIONS') reply.code(204).send();
});

// --- Token auth (enabled only when tokens are configured) ---
const INGEST_ROUTES = new Set(['/v1/logs', '/v1/metrics', '/v1/traces', '/activity']);
function presentedToken(req: { headers: Record<string, unknown>; url: string }): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  const hdr = req.headers['x-aad-token'];
  if (typeof hdr === 'string') return hdr;
  const q = req.url.split('?')[1];
  if (q) return new URLSearchParams(q).get('token') ?? undefined;
  return undefined;
}
app.addHook('onRequest', async (req, reply) => {
  const path = req.url.split('?')[0];
  const isIngest = INGEST_ROUTES.has(path);
  const isViewer = path.startsWith('/api/') || path === '/live';
  const required = isIngest ? config.ingestToken : isViewer ? config.viewerToken : undefined;
  if (required && presentedToken(req) !== required) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

// --- Body parser that tolerates gzip + non-JSON content-types from OTLP ---
app.addContentTypeParser(
  ['application/json', 'application/x-protobuf', 'application/octet-stream', '*'],
  { parseAs: 'buffer' },
  (req, body: Buffer, done) => {
    try {
      let buf = body;
      if (req.headers['content-encoding']?.includes('gzip') && buf.length) {
        buf = gunzipSync(buf);
      }
      if (!buf.length) return done(null, {});
      done(null, JSON.parse(buf.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

await app.register(websocket);
registerWebSocket(app, store);

// --- OTLP ingest ---
app.post('/v1/logs', async (req, reply) => {
  store.ingestMany(parseLogs(req.body));
  return reply.send({});
});
app.post('/v1/metrics', async (req, reply) => {
  store.ingestMany(parseMetrics(req.body));
  return reply.send({});
});
app.post('/v1/traces', async (_req, reply) => reply.send({})); // accept, ignore for POC

// --- Hook activity ---
interface ActivityBody {
  event?: ActivitySubtype;
  session_id?: string;
  user?: string;
  team_id?: string;
  department?: string;
  repo?: string;
  branch?: string;
  ticket?: string;
  cwd?: string;
  tool_name?: string;
  provider?: 'claude' | 'codex';
  client?: 'cli' | 'desktop' | 'vscode' | 'unknown';
}

app.post('/activity', async (req, reply) => {
  const b = (req.body ?? {}) as ActivityBody;
  if (!b.session_id || !b.event) {
    return reply.code(400).send({ error: 'session_id and event are required' });
  }
  // Prefer an explicit ticket; else derive the key from the branch name.
  const branchKey = b.branch?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];
  const ticket = isTicketKey(b.ticket) ? b.ticket : isTicketKey(branchKey) ? branchKey : undefined;
  const ev: AgentEvent = {
    id: nextActivityId('act'),
    ts: Date.now(),
    kind: 'activity',
    provider: b.provider === 'codex' ? 'codex' : 'claude',
    client: b.client,
    subtype: b.event,
    sessionId: b.session_id,
    userEmail: b.user,
    teamId: b.team_id,
    department: b.department,
    repo: b.repo,
    branch: b.branch,
    ticket,
    ticketTitle: ticket ? cachedTitle(ticket) : undefined,
    cwd: b.cwd,
    toolName: b.tool_name,
  };
  store.ingest(ev);

  // Resolve the real Jira title in the background; refresh the card if found.
  if (ticket) {
    resolveTitle(ticket).then((title) => {
      if (title && title !== ticket) {
        store.ingest({
          id: nextActivityId('title'),
          ts: Date.now(),
          kind: 'activity',
          provider: b.provider === 'codex' ? 'codex' : 'claude',
          client: b.client,
          subtype: 'context_update',
          sessionId: b.session_id,
          ticket,
          ticketTitle: title,
        });
      }
    });
  }
  return reply.send({ ok: true });
});

// --- Reads for the UI ---
app.get('/healthz', async () => ({
  ok: true,
  sessions: store.getSessions().length,
  events: store.getRecentEvents().length,
}));
app.get('/api/state', async () => ({
  sessions: store.getSessions(),
  aggregate: store.getAggregate(),
  recentEvents: store.getRecentEvents(100),
}));
app.get<{ Params: { promptId: string } }>('/api/prompt/:promptId', async (req) => ({
  events: store.getPromptEvents(req.params.promptId),
}));
// Persisted history: daily trends + per-agent timeline (survive restarts).
app.get<{ Querystring: { days?: string } }>('/api/trends', async (req) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  return history.trends(days);
});
app.get<{ Params: { agent: string } }>('/api/history/agent/:agent', async (req) =>
  history.agentHistory(req.params.agent),
);

// Latest DORA/cost metrics written by the baseline/collector run (if any).
app.get('/api/dora', async (_req, reply) => {
  try {
    const raw = await readFile(DORA_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return reply.code(404).send({ error: 'no metrics yet — run analytics/baseline/extract.mjs' });
  }
});

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => app.log.info(`Agent Activity Dashboard server on ${addr} (ws /live)`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
