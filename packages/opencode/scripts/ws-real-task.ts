// Real two-opencode delegation with an actual task.
//
// Spawns `opencode websocket` (the "sub-agent") and uses it
// to do a code review of the websocket bridge itself. The
// prompt is a real request that exercises the agent's tool
// use (read, grep, etc.) and produces useful output — not
// a "what is X" trivia question.
//
// Run from packages/opencode:
//   bun run scripts/ws-real-task.ts

import { spawn, type Subprocess } from "bun"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"

const probe = Bun.serve({ port: 0, fetch: () => new Response() })
const port = probe.port ?? 0
await probe.stop()

const entry = resolvePath(process.cwd(), "src/index.ts")
const tempDir = await fs.mkdtemp(join(tmpdir(), "ws-real-"))
// OpenCode's "outside cwd" permission rule is checked against the
// bridge's working directory, not the demo's. Setting cwd to the
// repo root so the agent can read packages/opencode/src/cli/cmd/
// websocket/ without a per-path permission grant.
const repoRoot = resolvePath(process.cwd(), "../..")

console.log(`[demo] spawning sub-agent on ws://127.0.0.1:${port}/ws`)
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
  ],
  env: { ...process.env, OPENCODE_PRINT_LOGS: "1" },
  cwd: repoRoot,
  stdout: "pipe",
  stderr: "pipe",
})
const tag = "[agent]"
void readPipe(bridge.stdout as ReadableStream<Uint8Array> | undefined, tag)
void readPipe(bridge.stderr as ReadableStream<Uint8Array> | undefined, tag)

async function waitForHealth(url: string, ms: number): Promise<boolean> {
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
async function readPipe(stream: ReadableStream<Uint8Array> | undefined, tag: string) {
  if (!stream) return
  const reader = stream.getReader()
  const dec = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      for (const line of dec.decode(value).split("\n")) {
        if (line.trim()) process.stderr.write(`${tag} ${line}\n`)
      }
    }
  } catch {}
}

function openAndAwaitWelcome(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener(
      "open",
      () => {
        const onMsg = (ev: MessageEvent) => {
          const m = JSON.parse(String(ev.data)) as { type: string }
          if (m.type === "welcome") {
            ws.removeEventListener("message", onMsg)
            resolve(ws)
          }
        }
        ws.addEventListener("message", onMsg)
      },
      { once: true },
    )
    setTimeout(() => reject(new Error("welcome timeout")), 10_000)
  })
}

function sendAndAwait(ws: WebSocket, msg: object, expect: string[], ms: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg)
      reject(new Error(`timeout waiting for ${expect.join("|")} after ${(msg as { type: string }).type}`))
    }, ms)
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type: string }
        if (expect.includes(m.type)) {
          clearTimeout(timer)
          ws.removeEventListener("message", onMsg)
          resolve(m)
        }
      } catch {}
    }
    ws.addEventListener("message", onMsg)
    ws.send(JSON.stringify(msg))
  })
}

function collectText(ws: WebSocket, sessionId: string, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const pieces: string[] = []
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg)
      resolve(pieces.join("") || "(timeout — model didn't respond in time)")
    }, ms)
    let active = false
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as any
        if (m.type === "event" && m.event) {
          const e = m.event
          if (e.type === "message.part.updated") {
            const p = e.properties?.part
            if (p?.sessionID !== sessionId) return
            if (p.type === "text" && typeof p.text === "string") {
              active = true
              pieces.push(p.text)
            } else if (p.type === "tool") {
              const name = p.tool ?? "?"
              const state = p.state ?? "?"
              const input = JSON.stringify(p.input ?? {}).slice(0, 200)
              console.log(`\n[sub-agent] 🔧 tool=${name} state=${state} input=${input}`)
            }
          } else if (e.type === "session.status" && active) {
            const st = e.properties?.status?.type
            if (st === "idle" || st === "error") {
              clearTimeout(timer)
              ws.removeEventListener("message", onMsg)
              resolve(pieces.join(""))
            }
          }
        }
      } catch {}
    }
    ws.addEventListener("message", onMsg)
  })
}

const baseUrl = `ws://127.0.0.1:${port}/ws`
const health = await waitForHealth(`http://127.0.0.1:${port}/health`, 30_000)
if (!health) {
  bridge.kill("SIGKILL")
  throw new Error("bridge never became healthy")
}

console.log("[demo] connecting...")
const ws = await openAndAwaitWelcome(baseUrl)

console.log("[demo] creating session...")
ws.send(JSON.stringify({ type: "new_session" }))
const created = (await sendAndAwait(ws, { type: "_" }, ["session_created", "error"], 10_000)) as {
  type: string
  sessionId: string
}
if (created.type !== "session_created") {
  bridge.kill("SIGKILL")
  throw new Error("new_session failed: " + JSON.stringify(created))
}
const sessionId = created.sessionId
console.log(`[demo] session: ${sessionId}`)

// The real task: a real write+read cycle, should finish in 2-3 turns.
// Uses bash so we can see the file was actually created.
const task = `Use the bash tool to do the following, then report back:

1. Run: \`mkdir -p /tmp/sub-agent-demo\`
2. Run: \`date\` and capture the current timestamp
3. Write a file to /tmp/sub-agent-demo/report.md with this content (substitute the real timestamp):
   ---
   # Report from sub-agent
   - timestamp: <the date you captured>
   - model: omlx/Qwen3.6-27B-UD-MLX-4bit
   - task: write this report
   - status: success
   ---
4. Run: \`cat /tmp/sub-agent-demo/report.md\` to confirm the file contents
5. Report a 1-sentence success line.

Keep it terse. The point is to prove end-to-end tool use works.`

console.log(`\n[demo] >>> task: ${task.slice(0, 100)}...`)
const collecting = collectText(ws, sessionId, 300_000) // 5 min
ws.send(JSON.stringify({ type: "prompt", sessionId, text: task }))
console.log("[demo] waiting for agent to do the work (up to 4 min)...")

const reply = await collecting
console.log("\n[demo] <<< agent response:\n")
console.log("─".repeat(72))
console.log(reply)
console.log("─".repeat(72))

ws.close()
bridge.kill("SIGTERM")
try {
  await Promise.race([bridge.exited, new Promise<void>((r) => setTimeout(r, 5_000))])
} catch {}
try {
  bridge.kill("SIGKILL")
} catch {}
await fs.rm(tempDir, { recursive: true, force: true })
console.log("\n[demo] done")
