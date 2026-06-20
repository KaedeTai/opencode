# @opencode-ai/websocket

Standalone WebSocket bridge for opencode. Runs a separate Bun server that
wraps the opencode SDK and forwards every event over a WebSocket connection,
so clients that can't or don't want to use SSE (browsers, mobile apps,
desktop frontends) can drive an opencode session in real time.

This package is **not** loaded by the `opencode` CLI. Run it as a sidecar
when you need a WS interface; otherwise the CLI's built-in SSE stream
(`GET /event`) is the default.

## Run

```bash
# from repo root
bun run --filter '@opencode-ai/websocket' dev
```

The server listens on `ws://localhost:9999/ws` by default. Override with
`WEBSOCKET_PORT`.

## Protocol

All messages are JSON. The server forwards every `opencode` event as
`{ type: "event", event: <GlobalEvent> }`.

Client → server messages:

| type           | fields            | effect                                          |
|----------------|-------------------|-------------------------------------------------|
| `new_session`  | —                 | creates a session, returns `{type:"session_created", sessionId}` |
| `prompt`       | `text: string`    | sends a text prompt on the active session       |
| `abort`        | —                 | aborts the active session                       |
| `status`       | —                 | returns `{type:"status", sessionId, connected}` |

The server sends a `welcome` message on connect and `error` messages on
bad input.

## Endpoints

- `GET /` or `/info` — service metadata + connected client count
- `GET /health` — `{status:"ok", clients:N}` for liveness checks
- `GET /ws` — WebSocket upgrade

## When to use this

- You want a non-Telegram bot interface that survives the opencode
  process being re-launched
- You're building a custom frontend (web, native) and prefer WebSocket
  framing over SSE
- You want a single multiplexed pipe for events + commands instead of
  separate HTTP + SSE calls

For a single chat client on the same host, the opencode CLI's built-in
`/event` SSE endpoint is simpler and doesn't need this sidecar.
