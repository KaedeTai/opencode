# opencode architecture

## Layered model

```
CLI (src/cli/cmd/)          ← user-facing commands: telegram, websocket, run, serve, ...
  └─ Commands/Server        ← Server is the in-process HTTP server that all commands reuse
       └─ Instance          ← per-project (cwd) state: database, sessions, file watcher
            └─ Session      ← conversation state: messages, parts, status, agent runs
                 └─ Agent   ← build + tool loop
                      └─ Tool ← the leaf: read, write, bash, ws_client, ...
```

- **Tool layer** is where leaf capability lives. A tool is a single function with a `Schema.Struct` for params and a `Tool.Context` for the calling session. **The tool is where the model meets the world** — anything that delegates, fetches, or has side effects is a tool.
- **Session layer** is the conversation: messages, parts, status. Stateless from the tool's perspective.
- **Instance layer** is per-cwd state: database, file watcher, location services. **Tools do not reach across instances** — a tool's effect is scoped to the cwd it was called in.
- **Server layer** is shared in-process HTTP. Multiple CLI commands can attach to the same server.

## The subagent system (meatiest part)

Four tools, one purpose — delegate work to another agent:

| Tool | Lives | Use it for |
|---|---|---|
| `task` | in-process | Generic subagent for any one-off delegation. Default. |
| `explore` | in-process | Read-only, search-focused subagent. Cannot mutate. |
| `general` (subagent_type) | in-process | Same as `task`, explicit name. |
| `ws_client` | cross-process | A *separate* opencode instance reachable over WebSocket. For persistence, isolation, model switching. |

**Decision rule**: try `task` first. Reach for `ws_client` only when you need a long-lived peer that survives across many turns, or model isolation, or a different cwd. The bridge is heavy (~800 MB resident, 5–10 s boot); don't pay that cost for one-off work.

### The websocket bridge

```
[parent opencode]                           [bridge opencode]
   ws_client tool                                opencode websocket
        │                                              ▲
        │  ws://…:9999/ws                              │
        └──── new_session / prompt / switch_session ───┘
                          (wire protocol)
```

- The bridge is a long-lived `opencode websocket` process. Spawned once via `scripts/ws-spawn-keepalive.ts`, kept alive by `detached: true` (Linux process leader, survives parent exit).
- **Wire protocol** (`packages/opencode/src/cli/cmd/websocket/protocol.ts`): a typed JSON message stream. Server sends `welcome`, `session_created`, `prompt_accepted`, and `event` envelopes. Client sends `new_session`, `switch_session`, `prompt`. Read protocol.ts before adding new messages.
- **Per-client session state** lives in `ClientState` (sessions.ts). The bridge's `switch_session` has a server-side fallback: if the sessionId isn't in the client map, it calls `client.session.get` on the opencode SDK and adopts the session. Without this, session persistence across WS reconnects is broken.
- **Cross-process state** lives in `~/.config/opencode/peer-session.json` (last-used sessionId) and `~/.config/opencode/peer-tasks/<id>.json` (detached task results). The state dir lives next to `opencode.jsonc` so it's a single user config location.

### Why the bridge exists (and what it's not for)

- It's **not** a thin RPC layer for "send a prompt". Use `task` for that.
- It **is** a way to talk to a *separate* opencode process — different cwd, different model, different lifetime, different permission context.
- The repo has a history of conflating the two. Don't add features to the bridge that should live in `task`.

## The tool runtime

A `Tool.define(...)` produces a `Tool.Definition` that the runtime wires into the agent loop. Important contract:

- `parameters: Schema.Struct(...)` — describes the params; the LLM sees this as a JSON Schema.
- `.txt` file next to the tool — the LLM-visible description. Keep it short, front-load the "when to use / when not to use" call. The runtime concatenates this with skill descriptions.
- `execute(params, ctx)` returns an Effect. `ctx` gives you `sessionID`, `messageID`, `agent`, `ask` (permission gate), `metadata` (post-hoc UI update), `abort` (signal).
- The Effect must resolve with `{ title, output, metadata }`. `output` is what the LLM sees next turn.
- **Long-running work** goes through `BackgroundJob.start({ run: Effect<string, unknown> })`. Don't `Bun.spawn` a worker — that bypasses the in-process job system. The pattern in `ws_client` for `detached: true` is the canonical example.

## Permissions

Every tool with side effects must call `ctx.ask({ permission, patterns, always, metadata })` for non-default actions. Localhost / `127.0.0.1` is implicit-allow (same trust model as `webfetch`); anything else asks the user. **If your tool is meant to be called unattended, you have a permissions bug** — fix it at the schema level, not by silently allowing.

## What lives where

- `packages/opencode/src/cli/cmd/<name>/` — CLI command (index.ts + helpers)
- `packages/opencode/src/tool/<name>.{ts,txt}` — built-in tool
- `packages/opencode/src/skill/` — skill service (loads `SKILL.md` from `.opencode/skills/*`)
- `packages/opencode/src/background/` — BackgroundJob re-export from core
- `packages/opencode/src/effect/` — runtime helpers (InstanceState, makeRuntime, etc.)
- `packages/opencode/test/cli/cmd/<name>.test.ts` — test for a CLI command
- `packages/opencode/test/tool/<name>.test.ts` — test for a tool
- `packages/opencode/scripts/<name>.ts` — standalone dev scripts (run via `bun run`)
- `packages/opencode/dist/<platform>/bin/opencode` — the compiled binary
- `/tmp/sub-agent-keepalive/` — keep-alive bridge state dir (see `cheatsheet.md`)
