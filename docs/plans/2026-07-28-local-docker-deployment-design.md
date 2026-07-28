# Local Docker deployment design

## Goal

Run the complete Agent Activity Dashboard POC through Docker Compose on a
stable local port that does not conflict with existing developer services.

The selected default is `127.0.0.1:18418`. Ports `4318` and `5173` are already
in use on the target machine; `18418` was verified free before implementation.

## Architecture

Compose runs two containers:

- `server`: the Fastify ingestion/history/WebSocket process on the private
  Compose network.
- `dashboard`: Nginx serving the production UI and reverse-proxying telemetry,
  API, health, activity, and WebSocket routes to `server:4318`.

Only Nginx publishes a host port. Binding to `127.0.0.1` keeps the POC local.

## Images

A multi-stage Dockerfile installs from the lockfile once, builds both
workspaces, and exposes two runtime targets:

- a minimal Node server image containing production dependencies and compiled
  server output;
- an Nginx image containing the Vite production bundle and proxy
  configuration.

The UI resolves an absent `VITE_SERVER_URL` to the current browser origin so
HTTP and WebSocket traffic share the Docker proxy origin.

## Data and runtime

A named volume is mounted at `/app/server/data` for SQLite history and the cost
ledger. The server and dashboard have health checks and restart policies.
Compose accepts `AAD_PORT` as an override while defaulting to `18418`.

## Verification

The deployment is complete when:

1. both images build;
2. both containers become healthy;
3. `/healthz` succeeds through port `18418`;
4. Claude and Codex hook events appear in `/api/state`;
5. Codex OTLP JSON is accepted through the reverse proxy;
6. the browser shows both providers and provider filtering works;
7. SQLite history survives a Compose restart;
8. the stack remains running for local testing.

