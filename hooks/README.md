# Hooks — local context bridge

Claude Code's telemetry doesn't know the **ticket**, the **branch**, or which
tool is running **right now** (OTel only emits `tool_result` *after* a tool
finishes). These hooks fill that gap: they POST structural context to the
dashboard's `/activity` endpoint on each lifecycle event.

`hook.js` handles all six events and derives the type from `hook_event_name`:

| Event | Effect on the session card |
|---|---|
| `SessionStart` | create the card, attach repo/branch/ticket/cwd |
| `UserPromptSubmit` | status → **thinking**, start a new turn |
| `PreToolUse` | status → **tool**, show the current tool name |
| `PostToolUse` | status → **thinking** (tool finished) |
| `Stop` | status → **idle** (turn finished) |
| `SessionEnd` | remove the card |

## Privacy

`hook.js` forwards **only** `session_id`, `repo`, `branch`, `ticket`, `cwd`,
`user`, `team.id`/`department` (from `OTEL_RESOURCE_ATTRIBUTES`), and — on tool
events — the `tool_name`. It never reads or sends the prompt text or tool
input/output. It always exits 0, so it can never block a Claude Code action.

## Install

1. Make sure the dashboard server is running (`npm run dev:server`).
2. Merge [`settings.snippet.json`](./settings.snippet.json) into your Claude Code
   settings (`~/.claude/settings.json` for all projects, or a project's
   `.claude/settings.json`). Adjust the absolute path if you cloned elsewhere.
3. Restart the `claude` session (hooks load at startup).

## Config (env, optional)

| Var | Default | Meaning |
|---|---|---|
| `AAD_URL` | `http://localhost:4318` | dashboard base URL |
| `AAD_USER` | `git config user.email` → `$USER` | actor label |
| `OTEL_RESOURCE_ATTRIBUTES` | — | `team.id` / `department` reused as the stream tag |

## Ticket detection

The ticket key is parsed from the branch name with `/[A-Z][A-Z0-9]+-\d+/`
(e.g. `feature/ABC-412-signup` → `ABC-412`). The title is resolved server-side
via Jira when credentials are configured; otherwise the bare key is shown.

## Test a hook by hand

```bash
echo '{"hook_event_name":"SessionStart","session_id":"test-1","cwd":"'"$PWD"'"}' \
  | node hooks/hook.js
# → a card for this repo should appear on the dashboard
```
