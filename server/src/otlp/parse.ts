// Parse OTLP/JSON (protobuf-JSON) payloads from Claude Code into normalized
// AgentEvents. Handles the log and metric shapes we care about, defensively —
// unknown fields are ignored, never thrown on.
import type { AgentEvent, EventKind } from '../types.js';

let seq = 0;
function nextId(): string {
  seq = (seq + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${seq.toString(36)}`;
}

// OTLP AnyValue -> JS primitive.
type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
};
type KeyValue = { key: string; value?: AnyValue };

function coerce(v?: AnyValue): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue); // protojson sends int64 as string
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(coerce);
  if (v.kvlistValue) return flattenKV(v.kvlistValue.values ?? []);
  return undefined;
}

function flattenKV(kvs: KeyValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of kvs) if (kv?.key) out[kv.key] = coerce(kv.value);
  return out;
}

function nanoToMs(nano?: string | number): number {
  if (nano === undefined) return Date.now();
  const n = typeof nano === 'string' ? Number(nano) : nano;
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1e6) : Date.now();
}

function str(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  return typeof v === 'string' ? v : v === undefined ? undefined : String(v);
}
function n(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  return typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !isNaN(Number(v)) ? Number(v) : undefined;
}

// Claude Code event.name (e.g. "claude_code.api_request") -> our EventKind.
const KIND_BY_EVENT: Record<string, EventKind> = {
  'claude_code.user_prompt': 'user_prompt',
  'claude_code.tool_result': 'tool_result',
  'claude_code.tool_decision': 'tool_decision',
  'claude_code.api_request': 'api_request',
  'claude_code.api_error': 'api_error',
  'claude_code.mcp_server_connection': 'mcp_connection',
};

function identityFrom(resAttrs: Record<string, unknown>, attrs: Record<string, unknown>) {
  return {
    userEmail: str(attrs, 'user.email') ?? str(resAttrs, 'user.email'),
    teamId: str(resAttrs, 'team.id') ?? str(attrs, 'team.id'),
    department: str(resAttrs, 'department') ?? str(attrs, 'department'),
    terminalType: str(attrs, 'terminal.type'),
    sessionId: str(attrs, 'session.id') ?? str(resAttrs, 'session.id'),
    promptId: str(attrs, 'prompt.id'),
  };
}

/** Parse an OTLP/JSON ExportLogsServiceRequest into AgentEvents. */
export function parseLogs(body: unknown): AgentEvent[] {
  const events: AgentEvent[] = [];
  const resourceLogs = (body as any)?.resourceLogs;
  if (!Array.isArray(resourceLogs)) return events;

  for (const rl of resourceLogs) {
    const resAttrs = flattenKV(rl?.resource?.attributes ?? []);
    for (const sl of rl?.scopeLogs ?? []) {
      for (const rec of sl?.logRecords ?? []) {
        const attrs = flattenKV(rec?.attributes ?? []);
        const eventName =
          str(attrs, 'event.name') ??
          (typeof rec?.body?.stringValue === 'string' ? rec.body.stringValue : undefined) ??
          str(attrs, 'name');
        const kind = eventName ? KIND_BY_EVENT[eventName] : undefined;
        if (!kind) continue; // ignore log records we don't model

        const id = identityFrom(resAttrs, attrs);
        const ev: AgentEvent = {
          id: nextId(),
          ts: nanoToMs(rec?.timeUnixNano ?? rec?.observedTimeUnixNano),
          kind,
          ...id,
        };

        switch (kind) {
          case 'tool_result':
            ev.toolName = str(attrs, 'tool_name') ?? str(attrs, 'name');
            ev.success = attrs['success'] === true || attrs['success'] === 'true';
            ev.durationMs = n(attrs, 'duration_ms');
            break;
          case 'tool_decision':
            ev.toolName = str(attrs, 'tool_name') ?? str(attrs, 'name');
            ev.decision = (str(attrs, 'decision') as 'accept' | 'reject') ?? undefined;
            ev.decisionSource = str(attrs, 'source');
            break;
          case 'api_request':
            ev.model = str(attrs, 'model');
            ev.inputTokens = n(attrs, 'input_tokens');
            ev.outputTokens = n(attrs, 'output_tokens');
            ev.costUsd = n(attrs, 'cost_usd');
            ev.durationMs = n(attrs, 'duration_ms');
            break;
          case 'api_error':
            ev.statusCode = n(attrs, 'status_code');
            ev.attempt = n(attrs, 'attempt');
            ev.model = str(attrs, 'model');
            ev.durationMs = n(attrs, 'duration_ms');
            break;
          case 'mcp_connection':
            ev.mcpServer = str(attrs, 'server_name') ?? str(attrs, 'name');
            ev.mcpState = str(attrs, 'state') ?? str(attrs, 'status');
            break;
          case 'user_prompt':
            // prompt.id carried in identity; length is non-sensitive
            break;
        }
        events.push(ev);
      }
    }
  }
  return events;
}

/** Parse an OTLP/JSON ExportMetricsServiceRequest into lightweight metric events. */
export function parseMetrics(body: unknown): AgentEvent[] {
  const events: AgentEvent[] = [];
  const resourceMetrics = (body as any)?.resourceMetrics;
  if (!Array.isArray(resourceMetrics)) return events;

  for (const rm of resourceMetrics) {
    const resAttrs = flattenKV(rm?.resource?.attributes ?? []);
    for (const sm of rm?.scopeMetrics ?? []) {
      for (const metric of sm?.metrics ?? []) {
        const name: string | undefined = metric?.name;
        if (!name) continue;
        const dps =
          metric?.sum?.dataPoints ??
          metric?.gauge?.dataPoints ??
          metric?.histogram?.dataPoints ??
          [];
        for (const dp of dps) {
          const attrs = flattenKV(dp?.attributes ?? []);
          const id = identityFrom(resAttrs, attrs);
          const value =
            dp?.asDouble !== undefined
              ? Number(dp.asDouble)
              : dp?.asInt !== undefined
                ? Number(dp.asInt)
                : dp?.sum !== undefined
                  ? Number(dp.sum)
                  : undefined;
          events.push({
            id: nextId(),
            ts: nanoToMs(dp?.timeUnixNano),
            kind: 'metric',
            metricName: name,
            metricValue: value,
            tokenType: str(attrs, 'type') ?? str(attrs, 'token_type'),
            model: str(attrs, 'model'),
            ...id,
          });
        }
      }
    }
  }
  return events;
}
