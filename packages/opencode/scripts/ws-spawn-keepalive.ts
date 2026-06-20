// Spawn a long-lived opencode websocket bridge using minimax-cn/MiniMax-M3.
//
// Unlike ws-real-task.ts this script does NOT wait for any task and does
// NOT kill the bridge. It:
//   1. Creates a temp cwd with its own opencode.jsonc that pins the model
//      to minimax-cn/MiniMax-M3 (uses the `minimax-cn` provider already
//      defined in the user's global opencode.jsonc).
//   2. Spawns `opencode websocket` detached, so it survives the parent.
//   3. Waits for /health to confirm it's up.
//   4. Persists { pid, port, wsUrl, httpUrl } to /tmp/sub-agent-keepalive/state.json
//      so future turns can reconnect without re-spawning.
//
// On a second run the script reuses the existing bridge if it's still
// healthy, instead of leaking a new one each time.
//
// Run from packages/opencode:
//   bun run scripts/ws-spawn-keepalive.ts

import { spawn, type Subprocess } from "bun"
import fs from "node:fs/promises"
import { resolve as resolvePath } from "node:path"

const STATE_DIR = "/tmp/sub-agent-keepalive"
const STATE_FILE = `${STATE_DIR}/state.json`
const BRIDGE_CONFIG = `${STATE_DIR}/opencode.jsonc`
const BRIDGE_LOG = `${STATE_DIR}/bridge.log`

interface State {
  pid: number
  port: number
  wsUrl: string
  httpUrl: string
  startedAt: string
  model: string
}

async function readState(): Promise<State | null> {
  try {
    return JSON.parse(await Bun.file(STATE_FILE).text()) as State
  } catch {
    return null
  }
}

async function isBridgeAlive(state: State): Promise<boolean> {
  try {
    process.kill(state.pid, 0)
  } catch {
    return false
  }
  try {
    const r = await fetch(`${state.httpUrl}/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

async function waitHealth(url: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

const existing = await readState()
if (existing && (await isBridgeAlive(existing))) {
  console.log(`[keepalive] bridge already alive`)
  console.log(`  pid:      ${existing.pid}`)
  console.log(`  port:     ${existing.port}`)
  console.log(`  wsUrl:    ${existing.wsUrl}`)
  console.log(`  httpUrl:  ${existing.httpUrl}`)
  console.log(`  model:    ${existing.model}`)
  console.log(`  started:  ${existing.startedAt}`)
  console.log(`  log:      ${BRIDGE_LOG}`)
  process.exit(0)
}

if (existing) console.log(`[keepalive] stale state (pid ${existing.pid} dead), respawning`)

await fs.mkdir(STATE_DIR, { recursive: true })

await Bun.write(
  BRIDGE_CONFIG,
  JSON.stringify(
    {
      model: "minimax-cn/MiniMax-M3",
      small_model: "minimax-cn/MiniMax-M3",
    },
    null,
    2,
  ),
)

const probe = Bun.serve({ port: 0, fetch: () => new Response() })
const port = probe.port ?? 0
await probe.stop()

const entry = resolvePath(process.cwd(), "src/index.ts")
console.log(`[keepalive] spawning bridge on port ${port}...`)
const bridge: Subprocess = spawn({
  cmd: [
    "bun",
    "run",
    "--conditions=browser",
    entry,
    "websocket",
    "--ws-port",
    String(port),
    "--hostname",
    "127.0.0.1",
    "--log-level",
    "INFO",
  ],
  env: { ...process.env, OPENCODE_PRINT_LOGS: "1" },
  cwd: STATE_DIR,
  stdout: "ignore",
  stderr: "ignore",
  // detached: child becomes its own session leader, survives parent exit.
  detached: true,
})

const httpUrl = `http://127.0.0.1:${port}`
const wsUrl = `ws://127.0.0.1:${port}/ws`

const healthy = await waitHealth(`${httpUrl}/health`, 30_000)
if (!healthy) {
  bridge.kill("SIGKILL")
  throw new Error("bridge failed to become healthy in 30s")
}

const state: State = {
  pid: bridge.pid,
  port,
  wsUrl,
  httpUrl,
  startedAt: new Date().toISOString(),
  model: "minimax-cn/MiniMax-M3",
}
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
console.log(`[keepalive] ✓ bridge ready`)
console.log(`  pid:      ${state.pid}`)
console.log(`  port:     ${state.port}`)
console.log(`  wsUrl:    ${state.wsUrl}`)
console.log(`  httpUrl:  ${state.httpUrl}`)
console.log(`  model:    ${state.model}`)
console.log(`  state:    ${STATE_FILE}`)
console.log(`  config:   ${BRIDGE_CONFIG}`)

// Detach: don't await bridge.exited, don't reference stdout/stderr.
// The child now runs independently. To stop later:
//   kill $(jq -r .pid /tmp/sub-agent-keepalive/state.json)

process.exit(0)
