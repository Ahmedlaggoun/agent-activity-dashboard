import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from './store.js';
import type { AgentEvent } from '../types.js';

function event(overrides: Partial<AgentEvent>): AgentEvent {
  return {
    id: Math.random().toString(36),
    ts: Date.now(),
    kind: 'activity',
    subtype: 'session_start',
    provider: 'codex',
    sessionId: 'session-1',
    ...overrides,
  };
}

test('keeps provider and client visible across hook state transitions', () => {
  const store = new Store();
  store.ingest(event({ client: 'vscode' }));
  store.ingest(event({ subtype: 'prompt_submit', client: 'vscode' }));
  store.ingest(event({ subtype: 'pre_tool', toolName: 'File edit', client: 'vscode' }));

  const [session] = store.getSessions();
  assert.equal(session.provider, 'codex');
  assert.equal(session.client, 'vscode');
  assert.equal(session.status, 'tool');
  assert.equal(session.currentTool, 'File edit');

  store.ingest(event({ subtype: 'post_tool', client: 'vscode' }));
  assert.equal(store.getSessions()[0].status, 'thinking');
});

test('does not merge Claude and Codex sessions into one provider identity', () => {
  const store = new Store();
  store.ingest(event({ sessionId: 'codex', provider: 'codex' }));
  store.ingest(event({ sessionId: 'claude', provider: 'claude', client: 'cli' }));

  const sessions = store.getSessions();
  assert.equal(sessions.find((session) => session.sessionId === 'codex')?.provider, 'codex');
  assert.equal(sessions.find((session) => session.sessionId === 'claude')?.provider, 'claude');
});

test('context enrichment does not reset live tool state', () => {
  const store = new Store();
  store.ingest(event({ subtype: 'session_start' }));
  store.ingest(event({ subtype: 'prompt_submit' }));
  store.ingest(event({ subtype: 'pre_tool', toolName: 'File edit' }));
  store.ingest(event({ subtype: 'context_update', ticketTitle: 'Login validation' }));

  const [session] = store.getSessions();
  assert.equal(session.status, 'tool');
  assert.equal(session.currentTool, 'File edit');
  assert.equal(session.ticketTitle, 'Login validation');
});
