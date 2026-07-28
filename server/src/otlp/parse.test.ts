import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLogs, parseMetrics } from './parse.js';

function s(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function i(key: string, value: number) {
  return { key, value: { intValue: String(value) } };
}

function b(key: string, value: boolean) {
  return { key, value: { boolValue: value } };
}

function logs(eventName: string, attributes: unknown[], resourceAttributes: unknown[] = []) {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: '1785240000000000000',
                attributes: [s('event.name', eventName), ...attributes],
              },
            ],
          },
        ],
      },
    ],
  };
}

test('keeps Claude parsing backward compatible and marks its provider', () => {
  const [event] = parseLogs(
    logs('claude_code.api_request', [
      s('session.id', 'claude-session'),
      s('model', 'claude-model'),
      i('input_tokens', 12),
      i('output_tokens', 7),
    ]),
  );

  assert.equal(event.provider, 'claude');
  assert.equal(event.kind, 'api_request');
  assert.equal(event.sessionId, 'claude-session');
  assert.equal(event.inputTokens, 12);
  assert.equal(event.outputTokens, 7);
});

test('normalizes Codex OTLP events without retaining prompt or tool content', () => {
  const [prompt] = parseLogs(
    logs(
      'codex.user_prompt',
      [
        s('conversation.id', 'codex-session'),
        s('turn.id', 'turn-1'),
        s('prompt', 'private source code must not survive'),
      ],
      [s('service.name', 'codex_cli_rs'), s('session_source', 'cli')],
    ),
  );
  const [tool] = parseLogs(
    logs('codex.tool_result', [
      s('conversation.id', 'codex-session'),
      s('tool', 'apply_patch'),
      b('success', true),
      s('output', 'secret tool output must not survive'),
      i('duration_ms', 42),
    ]),
  );

  assert.equal(prompt.provider, 'codex');
  assert.equal(prompt.client, 'cli');
  assert.equal(prompt.kind, 'user_prompt');
  assert.equal(prompt.sessionId, 'codex-session');
  assert.equal(prompt.promptId, 'turn-1');
  assert.equal(tool.provider, 'codex');
  assert.equal(tool.toolName, 'File edit');
  assert.equal(tool.success, true);
  assert.equal(tool.durationMs, 42);
  assert.doesNotMatch(JSON.stringify([prompt, tool]), /private source|secret tool output/);
});

test('maps failed Codex API requests to dashboard errors', () => {
  const [event] = parseLogs(
    logs('codex.api_request', [
      s('conversation_id', 'codex-session'),
      s('model', 'gpt-test'),
      b('success', false),
      i('status_code', 429),
      i('duration_ms', 150),
    ]),
  );

  assert.equal(event.kind, 'api_error');
  assert.equal(event.provider, 'codex');
  assert.equal(event.statusCode, 429);
});

test('marks Codex metrics with their provider and client', () => {
  const [event] = parseMetrics({
    resourceMetrics: [
      {
        resource: { attributes: [s('service.name', 'codex_vscode')] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'codex.tool.call',
                sum: {
                  dataPoints: [
                    {
                      asInt: '3',
                      attributes: [s('conversation.id', 'codex-session')],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(event.provider, 'codex');
  assert.equal(event.client, 'vscode');
  assert.equal(event.metricName, 'codex.tool.call');
});
