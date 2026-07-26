// Mirror of server/src/types.ts WS contract (POC: duplicated, not shared pkg).

export type EventKind =
  | 'user_prompt'
  | 'tool_result'
  | 'tool_decision'
  | 'api_request'
  | 'api_error'
  | 'mcp_connection'
  | 'metric'
  | 'activity';

export interface AgentEvent {
  id: string;
  ts: number;
  kind: EventKind;
  subtype?: string;
  promptId?: string;
  sessionId?: string;
  userEmail?: string;
  teamId?: string;
  department?: string;
  toolName?: string;
  success?: boolean;
  durationMs?: number;
  decision?: 'accept' | 'reject';
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  statusCode?: number;
  metricName?: string;
  metricValue?: number;
  mcpServer?: string;
  mcpState?: string;
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
  turnStartedAt?: number;
  turnTokens: number;
  turnCostUsd: number;
  promptCount: number;
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
  recentErrors: Array<{ ts: number; statusCode?: number; model?: string; teamId?: string }>;
}

export type ServerMessage =
  | { type: 'snapshot'; sessions: SessionState[]; aggregate: Aggregate; recentEvents: AgentEvent[] }
  | { type: 'event'; event: AgentEvent }
  | { type: 'sessions'; sessions: SessionState[]; aggregate: Aggregate };
