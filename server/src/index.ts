import { gunzipSync } from 'node:zlib';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { Store } from './store/store.js';
import { parseLogs, parseMetrics } from './otlp/parse.js';
import { registerWebSocket } from './ws.js';
import { cachedTitle, isTicketKey, resolveTitle } from './jira.js';
import type { ActivitySubtype, AgentEvent } from './types.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 16 * 1024 * 1024 });
const store = new Store();

// --- CORS (local POC: allow the Vite dev origin) ---
app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'content-type,content-encoding');
  if (req.method === 'OPTIONS') reply.code(204).send();
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
    id: `${Date.now().toString(36)}-act`,
    ts: Date.now(),
    kind: 'activity',
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
          id: `${Date.now().toString(36)}-title`,
          ts: Date.now(),
          kind: 'activity',
          subtype: b.event, // no-op subtype re-application; enrich only
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

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => app.log.info(`Agent Activity Dashboard server on ${addr} (ws /live)`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
