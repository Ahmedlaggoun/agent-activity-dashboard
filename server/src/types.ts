// Shared domain types for the ingestion server.
// The WS contract (ServerMessage) is mirrored in ui/src/types.ts.

export type EventKind =
  | 'user_prompt' // OTel  claude_code.user_prompt
  | 'tool_result' // OTel  claude_code.tool_result
  | 'tool_decision' // OTel  claude_code.tool_decision
  | 'api_request' // OTel  claude_code.api_request
  | 'api_error' // OTel  claude_code.api_error
  | 'mcp_connection' // OTel  claude_code.mcp_server_connection
  | 'metric' // OTel  metric datapoint (e.g. session.count)
  | 'activity'; // hook   /activity payload

// Lifecycle subtype for hook-sourced ('activity') events.
export type ActivitySubtype =
  | 'session_start'
  | 'prompt_submit'
  | 'pre_tool'
  | 'post_tool'
  | 'stop'
  | 'session_end';

/** A normalized, privacy-safe event. Never contains prompt or tool content. */
export interface AgentEvent {
  id: string;
  ts: number; // epoch ms
  kind: EventKind;
  subtype?: ActivitySubtype;

  // correlation
  promptId?: string;
  sessionId?: string;

  // identity / grouping
  userEmail?: string;
  teamId?: string;
  department?: string;
  terminalType?: string;

  // tool events
  toolName?: string;
  success?: boolean;
  durationMs?: number;
  decision?: 'accept' | 'reject';
  decisionSource?: string;

  // api events
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  statusCode?: number;
  attempt?: number;

  // metric events
  metricName?: string;
  metricValue?: number;
  tokenType?: string; // token.usage: input | output | cacheRead | cacheCreation

  // mcp connection
  mcpServer?: string;
  mcpState?: string;

  // hook / local context
  repo?: string;
  branch?: string;
  ticket?: string;
  ticketTitle?: string;
  cwd?: string;
}

export type SessionStatus = 'idle' | 'thinking' | 'tool';

export interface SessionState {
  sessionId: string;
  teamId?: string;
  department?: string;
  userEmail?: string;
  repo?: string;
  branch?: string;
  ticket?: string;
  ticketTitle?: string;
  cwd?: string;

  status: SessionStatus;
  currentTool?: string;
  currentPromptId?: string;

  turnStartedAt?: number; // epoch ms of current turn
  turnTokens: number; // input+output tokens this turn (from api_request logs, if any)
  turnCostUsd: number; // cost this turn (from api_request logs, if any)

  sessionTokens: number; // cumulative tokens this session (from token.usage metrics)
  sessionCostUsd: number; // cumulative cost this session (from cost.usage metrics)

  promptCount: number; // prompts this session
  lastEventAt: number;
  startedAt: number;
}

export interface Aggregate {
  activeSessions: number;
  promptsLastHour: number;
  costTodayUsd: number;
  tokensTodayInput: number;
  tokensTodayOutput: number;
  editWriteAccepts: number;
  editWriteRejects: number;
  recentErrors: Array<{
    ts: number;
    statusCode?: number;
    model?: string;
    teamId?: string;
  }>;
}

// ---- WebSocket contract (server -> client) ----

export interface SnapshotMessage {
  type: 'snapshot';
  sessions: SessionState[];
  aggregate: Aggregate;
  recentEvents: AgentEvent[];
}
export interface EventMessage {
  type: 'event';
  event: AgentEvent;
}
export interface SessionsMessage {
  type: 'sessions';
  sessions: SessionState[];
  aggregate: Aggregate;
}

export type ServerMessage = SnapshotMessage | EventMessage | SessionsMessage;
