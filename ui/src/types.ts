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

export type AgentProvider = 'claude' | 'codex';
export type AgentClient = 'cli' | 'desktop' | 'vscode' | 'unknown';

export interface AgentEvent {
  id: string;
  ts: number;
  kind: EventKind;
  subtype?: string;
  provider: AgentProvider;
  client?: AgentClient;
  promptId?: string;
  sessionId?: string;
  userEmail?: string;
  agent?: string;
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
  provider: AgentProvider;
  client?: AgentClient;
  teamId?: string;
  department?: string;
  userEmail?: string;
  agent?: string;
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
  sessionTokens: number;
  sessionCostUsd: number;
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
