#!/usr/bin/env node
// Claude Code hook -> Agent Activity Dashboard bridge.
//
// Reads the hook JSON on stdin, adds local git context (repo/branch/ticket),
// and POSTs a lifecycle event to the dashboard's /activity endpoint.
//
// NEVER forwards prompt or tool content — only structural context. This script
// must never block a tool call: it swallows all errors and always exits 0.
//
// Install: see hooks/README.md. The subtype is derived from the hook event name
// (or an optional argv[2] override).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DASHBOARD_URL = process.env.AAD_URL ?? 'http://localhost:4318';
const TIMEOUT_MS = 1200;

const SUBTYPE_BY_EVENT = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'prompt_submit',
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  Stop: 'stop',
  SessionEnd: 'session_end',
};

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function parseResourceAttrs() {
  const raw = process.env.OTEL_RESOURCE_ATTRIBUTES ?? '';
  const out = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=');
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

function ticketFromBranch(branch) {
  const m = branch && branch.match(/[A-Z][A-Z0-9]+-\d+/);
  return m ? m[0] : undefined;
}

async function main() {
  const input = readInput();
  const subtype = process.argv[2] || SUBTYPE_BY_EVENT[input.hook_event_name];
  if (!subtype || !input.session_id) process.exit(0);

  const cwd = input.cwd || process.cwd();
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined;
  const topLevel = git(cwd, ['rev-parse', '--show-toplevel']);
  const repo = topLevel ? topLevel.split('/').pop() : undefined;
  const attrs = parseResourceAttrs();

  const payload = {
    event: subtype,
    session_id: input.session_id,
    user: process.env.AAD_USER || git(cwd, ['config', 'user.email']) || process.env.USER,
    team_id: attrs['team.id'],
    department: attrs['department'],
    repo,
    branch,
    ticket: ticketFromBranch(branch),
    cwd,
    // tool_name is present on PreToolUse / PostToolUse — structural, not content.
    tool_name: input.tool_name,
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(`${DASHBOARD_URL}/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch {
    /* dashboard down — ignore, never block Claude Code */
  } finally {
    clearTimeout(t);
  }
  process.exit(0);
}

main();
