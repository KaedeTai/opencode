# Cheatsheet

## Rebuild the binary

```bash
cd packages/opencode
bun run ./script/build.ts
# Binary at: packages/opencode/dist/opencode-darwin-arm64/bin/opencode
```

The build script cross-compiles for all platforms; the macOS arm64 binary is what `~/.local/bin/opencode` (and the telegram bot launcher) use.

## Type-check

```bash
cd packages/opencode   # or whichever package
bun typecheck          # not `tsc` directly
```

## Run tests

```bash
cd packages/opencode
bun test test/cli/cmd/                 # all unit tests in this dir
WS_SMOKE=1 bun test test/cli/cmd/ws-smoke.test.ts  # e2e bridge test
```

Tests cannot run from the repo root. Always cd into a package.

## Keep-alive bridge lifecycle

```bash
# Start (or reuse) a bridge on ws://127.0.0.1:<port>/ws
bun run scripts/ws-spawn-keepalive.ts

# State and connection info
cat /tmp/sub-agent-keepalive/state.json
# { "pid": 42679, "port": 59747, "wsUrl": "ws://127.0.0.1:59747/ws", ... }

# Stop
kill $(jq -r .pid /tmp/sub-agent-keepalive/state.json)

# Send a one-off prompt (CLI helper)
bun run scripts/ws-ask.ts "your prompt here"
```

The bridge uses a temp cwd at `/tmp/sub-agent-keepalive/` with its own `opencode.jsonc` so it can have a different model than the parent opencode.

## Environment variables the opencode binary reads

- `WEBSOCKET_BRIDGE_URL` — default URL for the `ws_client` tool. `ws://host:port/ws`.
- `OPENCODE_PRINT_LOGS=1` — print logs to stderr (useful for debugging).
- `OPENCODE_DEFAULT_MODEL` — **not read**. The default model is in `opencode.jsonc`.
- `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` — enables `task({ background: true })`.
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` — read by the built-in `anthropic` provider.

## Config locations

- `~/.config/opencode/opencode.jsonc` — primary config (loaded first)
- `~/.config/opencode/opencode.json` — fallback (loaded if .jsonc is absent)
- `~/.config/opencode/peer-session.json` — last-used WS bridge session
- `~/.config/opencode/peer-tasks/<id>.json` — detached task results
- `<cwd>/opencode.jsonc` — per-project override (loaded before global)
- `<cwd>/.opencode/opencode.jsonc` — local override

`.jsonc` wins over `.json` when both exist.

## Common file paths

| What | Where |
|---|---|
| CLI commands | `packages/opencode/src/cli/cmd/<name>/index.ts` |
| Built-in tools | `packages/opencode/src/tool/<name>.{ts,txt}` |
| WebSocket bridge | `packages/opencode/src/cli/cmd/websocket/{index,server,sessions,events,protocol,log}.ts` |
| Subagent decision tree | `packages/opencode/src/tool/{task,explore}.ts` |
| Effect patterns | `.opencode/references/effect-smol` (clone if missing) |
| Skills | `.opencode/skills/<name>/SKILL.md` |
| Built binary | `packages/opencode/dist/<platform>/bin/opencode` |
| Detached task results | `~/.config/opencode/peer-tasks/<uuid>.json` |

## Quick code patterns

### Add a CLI command

```bash
mkdir -p packages/opencode/src/cli/cmd/<name>
# copy from the closest existing command as a template
# register it in packages/opencode/src/cli/index.ts (or wherever Command.list lives)
```

### Add a tool

```ts
// packages/opencode/src/tool/<name>.ts
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./<name>.txt"

const Parameters = Schema.Struct({
  // ...
})

export const MyTool = Tool.define(
  "<name>",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          // your work
          return { title: "...", output: "...", metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
```

Also write `packages/opencode/src/tool/<name>.txt` — the LLM-visible description. Front-load the "when to use / when not to use".

### Add a skill

```bash
mkdir -p .opencode/skills/<name>
# .opencode/skills/<name>/SKILL.md with frontmatter (name, description)
# optional supporting files
```

Skills are loaded on demand via the `skill` tool. The description in the frontmatter is what the LLM uses to decide when to invoke.

## Debugging

- `opencode --print-logs --log-level DEBUG <command>` — verbose logging to stderr.
- Look at the opencode process stderr — structured logs with `run=<id>` correlating events.
- For tool permission issues, the `ctx.ask` call is the gate. The user gets a `y/n` prompt; if unattended, the call hangs forever.
- The bridge's `/health` endpoint returns `{"status":"ok","clients":N}`. `clients` is the count of connected WS clients.
