# Codex live ingestion design

## Goal

Extend Agent Activity Dashboard from Claude-only telemetry to a shared live
Mission Control for Claude Code and Codex. The first increment must preserve
the existing Claude behavior while making Codex sessions, tool activity,
usage, and failures visible through the same domain model and UI.

## Chosen approach

Use Codex OpenTelemetry and Codex lifecycle hooks together:

- OpenTelemetry supplies structured model, usage, approval, tool-result, and
  error events.
- Lifecycle hooks supply immediate session and tool state plus local Git
  context.
- The server normalizes both sources into the existing `AgentEvent` and
  `SessionState` flow.

OTel alone is too delayed for a live board because Codex batches exports.
Hooks alone do not provide enough usage and API detail. Scraping Codex
transcripts or local SQLite state is rejected because those are private and
unstable integration surfaces.

## Domain model

Every normalized event and live session may carry:

- `provider`: `claude` or `codex`
- `client`: `cli`, `desktop`, `vscode`, or `unknown`

Missing provider information defaults to Claude for backward compatibility
with existing Claude hook payloads and saved UI expectations. The OTel parser
sets Codex explicitly for all `codex.*` events.

## Ingestion

The OTLP log parser recognizes Claude's existing event names and Codex event
names. It maps conversation starts, prompts, API requests, stream completion,
tool decisions, and tool results into privacy-safe normalized events. Raw
prompts, tool arguments, output snippets, and error bodies are never copied.

A Codex hook bridge handles `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `Stop`, and `SessionEnd`. It derives repository, branch, ticket,
and client context locally. Tool activity is reduced to a safe summary; shell
commands and tool inputs are never transmitted.

Codex is configured at the user level with OTLP/HTTP JSON and
`log_user_prompt = false`. This is compatible with the existing Fastify JSON
OTLP receiver and avoids adding protobuf dependencies.

## UI

The live dashboard:

- shows provider and client on session cards and detail views;
- supports `All`, `Claude`, and `Codex` filtering;
- retains team and agent filters;
- preserves the existing Board, Map, and Trends views.

The first increment does not redesign historical DORA analytics. Provider
dimensions are persisted so provider comparisons can be added later.

## Privacy and failure handling

- Prompt content is disabled at the exporter and ignored at ingestion.
- Raw shell commands, tool inputs, tool outputs, and Codex output snippets are
  discarded.
- File information, when later supported, must be repository-relative.
- Hooks always exit successfully and use short network timeouts so Mission
  Control cannot block Codex work.
- Unknown Codex events are ignored defensively.
- An unavailable dashboard does not interrupt Codex.

## Verification

Regression tests cover:

- existing Claude OTLP parsing;
- Codex OTLP parsing and provider/client normalization;
- absence of prompt and tool content in normalized events;
- provider-aware live session state;
- Codex hook payload sanitization.

The final verification runs server tests, TypeScript compilation, and the
production UI build.

## Deferred

- GitHub OAuth and role-based ACL;
- GitHub/Jira provider comparison dashboards;
- natural-language Jira linking;
- manual work classification;
- individual and team leaderboards;
- Bitrise and AWS deployment evidence.
