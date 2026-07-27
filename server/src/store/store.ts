import { EventEmitter } from 'node:events';
import type {
  AgentEvent,
  Aggregate,
  SessionState,
  SessionStatus,
} from '../types.js';
import { config } from '../config.js';
import { agentLabel } from '../identity.js';

function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * In-memory store. Holds a bounded ring buffer of recent events and derives
 * per-session state + aggregate counters from them. No persistence.
 *
 * Emits:
 *   'event'    (event: AgentEvent)          — one normalized event ingested
 *   'sessions' (sessions, aggregate)        — derived state changed
 */
export class Store extends EventEmitter {
  private ring: AgentEvent[] = [];
  private sessions = new Map<string, SessionState>();

  // Last-seen cumulative metric values per session (Claude Code emits
  // cost.usage / token.usage as monotonic cumulative sums). Kept separate from
  // `sessions` so day-counter deltas survive card eviction (session_end).
  private metricAgg = new Map<string, { cost: number; tokens: Record<string, number> }>();

  // Best-known agent label per session. Set once from an identity-bearing event
  // (session_start carries the email) so later identity-less events (metrics,
  // hooks) reuse the SAME person label instead of a weaker session-based one —
  // this is what makes one person's multiple sessions share a pseudonym.
  private agentBySession = new Map<string, string>();

  // Running counters (survive ring-buffer eviction), reset at local midnight.
  private dayStart = startOfLocalDay();
  private costTodayUsd = 0;
  private tokensInToday = 0;
  private tokensOutToday = 0;
  private editWriteAccepts = 0;
  private editWriteRejects = 0;

  constructor() {
    super();
    // Idle sweeper + TTL eviction.
    setInterval(() => this.sweep(), 5_000).unref();
  }

  ingest(event: AgentEvent): void {
    this.rolloverDayIfNeeded(event.ts);

    // Pseudonymize identity at the ingest boundary. A person label (from the
    // email) is authoritative and remembered per session; identity-less events
    // reuse it so the same person keeps one label across all their sessions.
    if (event.userEmail) {
      event.agent = config.anonymize ? agentLabel(event.userEmail) : event.userEmail;
      if (event.sessionId) this.agentBySession.set(event.sessionId, event.agent);
      if (config.anonymize) event.userEmail = undefined;
    } else if (event.sessionId) {
      event.agent =
        this.agentBySession.get(event.sessionId) ??
        (config.anonymize ? agentLabel(undefined, event.sessionId) : undefined);
    }

    this.ring.push(event);
    if (this.ring.length > config.ringSize) this.ring.shift();

    let changed: boolean;
    if (event.kind === 'metric') {
      changed = this.applyMetric(event);
    } else {
      this.applyToCounters(event);
      changed = this.applyToSession(event);
    }

    this.emit('event', event);
    if (changed) this.emit('sessions', this.getSessions(), this.getAggregate());
  }

  ingestMany(events: AgentEvent[]): void {
    for (const e of events) this.ingest(e);
  }

  // ---- counters ----

  private rolloverDayIfNeeded(ts: number): void {
    const day = startOfLocalDay(ts);
    if (day !== this.dayStart) {
      this.dayStart = day;
      this.costTodayUsd = 0;
      this.tokensInToday = 0;
      this.tokensOutToday = 0;
      this.editWriteAccepts = 0;
      this.editWriteRejects = 0;
    }
  }

  private applyToCounters(e: AgentEvent): void {
    if (e.kind === 'api_request') {
      if (e.costUsd) this.costTodayUsd += e.costUsd;
      if (e.inputTokens) this.tokensInToday += e.inputTokens;
      if (e.outputTokens) this.tokensOutToday += e.outputTokens;
    }
    if (e.kind === 'tool_decision' && (e.toolName === 'Edit' || e.toolName === 'Write')) {
      if (e.decision === 'accept') this.editWriteAccepts++;
      else if (e.decision === 'reject') this.editWriteRejects++;
    }
  }

  /**
   * Claude Code emits cost/tokens as cumulative (monotonic) sum metrics, tagged
   * with session.id. We track the last-seen cumulative per session and add the
   * *delta* to day counters (correct across midnight + card eviction), while the
   * session card shows the latest cumulative session total.
   * Returns true if anything visible changed.
   */
  private applyMetric(e: AgentEvent): boolean {
    const name = e.metricName;
    const value = e.metricValue;
    // session.count / active_time.total carry no counter data we accumulate.
    if (!name || value === undefined || (name !== 'claude_code.cost.usage' && name !== 'claude_code.token.usage')) {
      // Still enrich an existing session's identity/liveness from the metric.
      const existing = e.sessionId ? this.sessions.get(e.sessionId) : undefined;
      if (existing) {
        existing.lastEventAt = e.ts;
        if (e.teamId) existing.teamId = e.teamId;
        if (e.agent) existing.agent = e.agent;
        return true;
      }
      return false;
    }
    if (!e.sessionId) return false;

    const agg = this.metricAgg.get(e.sessionId) ?? { cost: 0, tokens: {} };
    let changed = false;

    if (name === 'claude_code.cost.usage') {
      const delta = Math.max(0, value - agg.cost);
      agg.cost = value;
      this.costTodayUsd += delta;
      if (delta > 0) {
        const sess = this.sessions.get(e.sessionId);
        this.emit('cost', {
          ts: e.ts,
          sessionId: e.sessionId,
          ticket: sess?.ticket,
          repo: sess?.repo,
          teamId: e.teamId ?? sess?.teamId,
          dUsd: +delta.toFixed(6),
        });
      }
      changed = true;
    } else {
      const type = e.tokenType ?? 'other';
      const prev = agg.tokens[type] ?? 0;
      const delta = Math.max(0, value - prev);
      agg.tokens[type] = value;
      if (type === 'output') this.tokensOutToday += delta;
      else this.tokensInToday += delta; // input / cacheRead / cacheCreation / other
      changed = true;
    }
    this.metricAgg.set(e.sessionId, agg);

    // Reflect cumulative totals on the card, but never resurrect an ended one.
    const s = this.sessions.get(e.sessionId);
    if (s) {
      s.lastEventAt = e.ts;
      if (e.teamId) s.teamId = e.teamId;
      if (e.agent) s.agent = e.agent;
      s.sessionCostUsd = agg.cost;
      s.sessionTokens = Object.values(agg.tokens).reduce((a, b) => a + b, 0);
    }
    return changed;
  }

  // ---- session derivation ----

  private ensureSession(e: AgentEvent): SessionState | undefined {
    if (!e.sessionId) return undefined;
    let s = this.sessions.get(e.sessionId);
    if (!s) {
      s = {
        sessionId: e.sessionId,
        status: 'idle',
        turnTokens: 0,
        turnCostUsd: 0,
        sessionTokens: 0,
        sessionCostUsd: 0,
        promptCount: 0,
        lastEventAt: e.ts,
        startedAt: e.ts,
      };
      this.sessions.set(e.sessionId, s);
    }
    // Enrich identity/context whenever present (last non-empty wins).
    if (e.teamId) s.teamId = e.teamId;
    if (e.department) s.department = e.department;
    if (e.userEmail) s.userEmail = e.userEmail;
    if (e.agent) s.agent = e.agent;
    if (e.repo) s.repo = e.repo;
    if (e.branch) s.branch = e.branch;
    if (e.ticket) s.ticket = e.ticket;
    if (e.ticketTitle) s.ticketTitle = e.ticketTitle;
    if (e.cwd) s.cwd = e.cwd;
    return s;
  }

  private setStatus(s: SessionState, status: SessionStatus, tool?: string): void {
    s.status = status;
    s.currentTool = status === 'tool' ? tool : undefined;
  }

  private startTurn(s: SessionState, ts: number, promptId?: string): void {
    s.status = 'thinking';
    s.currentTool = undefined;
    s.turnStartedAt = ts;
    s.turnTokens = 0;
    s.turnCostUsd = 0;
    s.promptCount++;
    if (promptId) s.currentPromptId = promptId;
  }

  /** Returns true if derived session state changed (so we should broadcast). */
  private applyToSession(e: AgentEvent): boolean {
    const s = this.ensureSession(e);
    if (!s) return false;
    s.lastEventAt = e.ts;

    switch (e.kind) {
      case 'user_prompt': // OTel — authoritative turn boundary (has prompt.id)
        this.startTurn(s, e.ts, e.promptId);
        return true;

      case 'api_request': {
        const tok = (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
        s.turnTokens += tok;
        s.sessionTokens += tok;
        if (e.costUsd) {
          s.turnCostUsd += e.costUsd;
          s.sessionCostUsd += e.costUsd;
        }
        if (s.status === 'idle') s.status = 'thinking';
        return true;
      }

      case 'tool_result':
        // Tool finished; if not already flipped by a PostToolUse hook, reflect it.
        if (s.status === 'tool') this.setStatus(s, 'thinking');
        return true;

      case 'activity':
        return this.applyActivity(s, e);

      case 'api_error':
      case 'tool_decision':
      case 'mcp_connection':
      case 'metric':
        return true; // counters/timeline only; keep card fresh via lastEventAt
    }
  }

  private applyActivity(s: SessionState, e: AgentEvent): boolean {
    switch (e.subtype) {
      case 'session_start':
        s.status = 'idle';
        return true;
      case 'prompt_submit':
        // Hooks lack prompt.id; only (re)start a turn if one isn't running.
        if (s.status === 'idle' || s.turnStartedAt === undefined) {
          this.startTurn(s, e.ts);
        } else {
          s.status = 'thinking';
          s.currentTool = undefined;
        }
        return true;
      case 'pre_tool':
        this.setStatus(s, 'tool', e.toolName);
        return true;
      case 'post_tool':
        this.setStatus(s, 'thinking');
        return true;
      case 'stop':
        s.status = 'idle';
        s.currentTool = undefined;
        s.turnStartedAt = undefined;
        return true;
      case 'session_end':
        this.sessions.delete(s.sessionId);
        return true;
      default:
        return true;
    }
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (now - s.lastEventAt > config.sessionTtlMs) {
        this.sessions.delete(id);
        this.agentBySession.delete(id);
        this.metricAgg.delete(id);
        changed = true;
        continue;
      }
      // Fallback idle detection (when Stop hook not installed).
      if (s.status !== 'idle' && s.status !== 'tool' && now - s.lastEventAt > config.idleMs) {
        s.status = 'idle';
        s.currentTool = undefined;
        changed = true;
      }
    }
    if (changed) this.emit('sessions', this.getSessions(), this.getAggregate());
  }

  // ---- reads ----

  getSessions(): SessionState[] {
    return [...this.sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt);
  }

  getRecentEvents(limit = 100): AgentEvent[] {
    return this.ring.slice(-limit);
  }

  /** Events for one prompt turn (detail drawer timeline). */
  getPromptEvents(promptId: string): AgentEvent[] {
    return this.ring.filter((e) => e.promptId === promptId);
  }

  getAggregate(): Aggregate {
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    // Count prompts from whichever source is active: the OTel user_prompt log
    // OR the prompt_submit hook. In practice only one fires per prompt for a
    // given deployment (real Claude Code emits the hook, not the log), so this
    // does not double-count.
    const promptsLastHour = this.ring.filter(
      (e) =>
        e.ts >= hourAgo &&
        (e.kind === 'user_prompt' || (e.kind === 'activity' && e.subtype === 'prompt_submit')),
    ).length;
    const activeSessions = this.getSessions().filter((s) => s.status !== 'idle').length;
    const recentErrors = this.ring
      .filter((e) => e.kind === 'api_error')
      .slice(-8)
      .map((e) => ({ ts: e.ts, statusCode: e.statusCode, model: e.model, teamId: e.teamId }));

    return {
      activeSessions,
      promptsLastHour,
      costTodayUsd: this.costTodayUsd,
      tokensTodayInput: this.tokensInToday,
      tokensTodayOutput: this.tokensOutToday,
      editWriteAccepts: this.editWriteAccepts,
      editWriteRejects: this.editWriteRejects,
      recentErrors,
    };
  }
}
