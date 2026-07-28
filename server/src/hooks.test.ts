import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, '../../hooks/hook.js');

test('Codex hook emits structural summaries without command or tool input', () => {
  const privateCommand = 'deploy --token super-secret';
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: resolve(here, '../..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      AAD_PROVIDER: 'codex',
      AAD_CLIENT: 'cli',
      AAD_DRY_RUN: '1',
      AAD_USER: '',
    },
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'codex-session',
      cwd: resolve(here, '../..'),
      tool_name: 'Bash',
      tool_input: { command: privateCommand },
      prompt: 'private prompt',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.provider, 'codex');
  assert.equal(payload.client, 'cli');
  assert.equal(payload.tool_name, 'Terminal command');
  assert.equal(payload.user, undefined);
  assert.doesNotMatch(result.stdout, /super-secret|private prompt|deploy --token/);
});
