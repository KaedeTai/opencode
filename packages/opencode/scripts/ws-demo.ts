// Real demo of "two opencodes together" via WebSocket.
//
// 1. Spawns `opencode websocket` in the background (this
//    IS the second opencode instance — the bridge runs an
//    in-process opencode server).
// 2. Connects to it from this script as a plain WS client.
// 3. Sends two prompts and prints what comes back.
//
// Run from packages/opencode:
//   bun run scripts/ws-demo.ts
//
// The bridge's stdout/stderr stream through so you can see
// what the remote opencode is doing.

import { spawn, type Subprocess } from "bun"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"

const probe = Bun.serve({ port: 0, fetch: () => new Response() })
const port = probe.port ?? 0
await probe.stop()

const entry = resolvePath(process.cwd(), "src/index.ts")
const tempDir = await fs.mkdtemp(join(tmpdir(), "ws-demo-"))

console.log(`[demo] spawning bridge on ws://127.0.0.1:${port}/ws`)
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
  env: {
    ...process.env,
    OPENCODE_PRINT_LOGS: "1",
    OPENCODE_DEFAULT_MODEL: process.env.OPENCODE_DEFAULT_MODEL ?? "anthropic/MiniMax-M3",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? "",
  },
  cwd: tempDir,
  stdout: "pipe",
  stderr: "pipe",
})

const tag = "[bridge]"
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

async function readJson<T = unknown>(ws: WebSocket, predicate: (m: any) => boolean, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg)
      reject(new Error("timeout"))
    }, ms)
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data))
        if (predicate(m)) {
          clearTimeout(timer)
          ws.removeEventListener("message", onMsg)
          resolve(m as T)
        }
      } catch {}
    }
    ws.addEventListener("message", onMsg)
  })
}

async function openAndAwaitWelcome(url: string): Promise<WebSocket> {
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

function sendPrompt(ws: WebSocket, sessionId: string, text: string): Promise<string> {
  return new Promise((resolve) => {
    const pieces: string[] = []
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg)
      resolve(pieces.join("") || "(timeout)")
    }, 60_000)
    let active = false
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as any
        if (m.type === "event" && m.event) {
          if (m.event.type === "message.part.updated") {
            const p = m.event.properties?.part
            if (p?.sessionID === sessionId && p.type === "text" && typeof p.text === "string") {
              active = true
              pieces.push(p.text)
            }
          } else if (m.event.type === "session.status" && active) {
            const st = m.event.properties?.status?.type
            if (st === "idle" || st === "error") {
              clearTimeout(timer)
              ws.removeEventListener("message", onMsg)
              resolve(pieces.join("") || `(session ${st})`)
            }
          }
        }
      } catch {}
    }
    ws.addEventListener("message", onMsg)
    queueMicrotask(() => {
      ws.send(JSON.stringify({ type: "prompt", sessionId, text }))
    })
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
console.log("[demo] connected, welcome received")

// Catch and print every inbound frame so we see what the
// bridge actually sends (helps debug timeout mysteries).
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data)) as { type: string }
  if (m.type !== "event" && m.type !== "pong") {
    console.log(`[ws] <<< ${m.type}`)
  }
})

console.log("[demo] creating session...")
// Send the new_session message BEFORE awaiting the
// response — the readJson helper just listens, it
// doesn't send. Forgetting to send is the kind of
// subtle bug that makes the demo silently hang.
ws.send(JSON.stringify({ type: "new_session" }))
const created = (await readJson<{ type: string; sessionId: string; message?: string }>(
  ws,
  (m) => m.type === "session_created" || m.type === "error",
  90_000,
))
if (created.type !== "session_created") {
  console.error(`[demo] session_create_failed: ${created.message ?? "unknown"}`)
  bridge.kill("SIGKILL")
  throw new Error("new_session failed")
}
const sessionId = created.sessionId
console.log(`[demo] session created: ${sessionId}`)

const questions = [
  "In one sentence, what is opencode?",
  "And what does its websocket command do?",
]

for (const q of questions) {
  console.log(`\n[demo] >>> ${q}`)
  const reply = await sendPrompt(ws, sessionId, q)
  console.log(`[demo] <<< ${reply.trim() || "(no text)"}`)
}

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
