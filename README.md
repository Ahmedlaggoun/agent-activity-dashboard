# Agent Activity Dashboard

Real-time, local dashboard showing **what Claude Code agents are doing** during
the build phase — who launched a prompt, on which ticket, which tool is running,
and how much it costs.

> Observability of **agents** (quality, security, cost) — not surveillance of people.
> Prompt content is never logged. Default view is aggregated by stream.

Built for a POC on developer Macs. No database: an in-memory ring buffer,
restartable and disposable.

---

## Two data sources

1. **OpenTelemetry (native to Claude Code).** Claude Code is itself an OTLP
   client — no instrumentation to write. It exports logs + metrics to this
   server's `/v1/logs` and `/v1/metrics` endpoints. See [`otel-env.sh`](./otel-env.sh).
2. **Claude Code hooks (local context).** The ticket, branch and live tool
   status are not in the telemetry. Hook scripts in [`hooks/`](./hooks) POST git
   context and lifecycle events to `/activity`.

## Architecture

```
Claude Code ──OTLP http/json──►┐
                               │   server/  (Fastify + TS)
hooks (SessionStart, …) ──────►┤   ├─ POST /v1/logs      (OTLP ingest)
                               │   ├─ POST /v1/metrics
                               │   ├─ POST /activity     (hooks)
                               │   ├─ ring buffer (500 events, no DB)
                               │   └─ WebSocket /live
                               └──────────────────► ui/  (React + Vite)
```

## Quick start

```bash
# 1. install (npm workspaces installs server + ui)
npm install

# 2. run the ingestion server (http://localhost:4318, ws on same port)
npm run dev:server

# 3. run the UI (http://localhost:5173)
npm run dev:ui

# 4. point a Claude Code session at the server, in the shell where you run `claude`:
source ./otel-env.sh
```

Then install the hooks (see [`hooks/README.md`](./hooks/README.md)) so the
dashboard gets ticket/branch context and precise live tool status.

## Verifying the pipeline

Before wiring the real endpoint, confirm Claude Code emits telemetry at all:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=console      # prints events to the claude terminal
claude
```

You should see `claude_code.session.count` at session start and
`claude_code.user_prompt` when you submit a prompt. If nothing appears, run
`claude --debug` and check for OTel export errors. Once confirmed, switch
`OTEL_LOGS_EXPORTER=otlp` and `source ./otel-env.sh`.

## Privacy & compliance (non-negotiable)

- **Prompt content is never logged.** `OTEL_LOG_USER_PROMPTS`,
  `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` are **never** set. The
  server neither receives nor stores prompt text.
- **Default view is aggregated by stream** (`team.id`), not nominative.
- **Retention:** the POC keeps nothing (ring buffer only). A persistent store,
  when added, is capped at **30 days**.
- **RH/RGPD:** a tool displaying named developers' activity is a processing of
  employees' personal data → CSE information-consultation and entry in the
  register of processing activities are required **before** any deployment
  beyond the POC.

## Layout

| Path | What |
|---|---|
| `server/` | Fastify OTLP ingest + ring buffer + WebSocket |
| `ui/` | React + Vite live dashboard |
| `hooks/` | Claude Code hook scripts (git context + lifecycle) |
| `otel-env.sh` | the `CLAUDE_CODE_ENABLE_TELEMETRY` export block |
