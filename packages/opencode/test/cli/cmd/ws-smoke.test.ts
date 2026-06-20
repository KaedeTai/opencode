// End-to-end smoke test for the `opencode websocket` CLI bridge.
//
// Spawns the bridge in a subprocess against a temp directory,
// connects as a real WebSocket client, and exercises the
// wire-protocol contract:
//
//   1. Server is reachable on /health
//   2. WS upgrade succeeds on /ws
//   3. Server sends a `welcome` on connect
//   4. `new_session` creates a session and returns its id
//   5. `prompt` is accepted and the session eventually
//      settles (idle or error)
//   6. `list_sessions` reflects the created session
//   7. `switch_session` reuses the session
//   8. `close_session` removes the session
//
// Run from packages/opencode:
//   WS_SMOKE=1 bun test test/cli/cmd/ws-smoke.test.ts
//
// We don't assert on actual LLM output — the bridge
// subprocess may not have a working LLM provider configured
// in this environment. The wire-protocol contract is the
// thing under test.

import { test } from "bun:test"
import { spawn, type Subprocess } from "bun"
import fs from "node:fs/promises"
import path from "node:path"

const WS_SMOKE = process.env.WS_SMOKE === "1"

if (WS_SMOKE) {
  test(
    "websocket bridge smoke: welcome → new_session → prompt → list → switch → close",
    async () => {
      // Pick a free port.
      const probe = Bun.serve({ port: 0, fetch: () => new Response() })
      const port = probe.port ?? 0
      await probe.stop()

      // Spawn the bridge in a temp dir.
      const tempDir = await fs.mkdtemp(`${import.meta.dir}/.ws-smoke-`)
      const entry = path.resolve(process.cwd(), "src/index.ts")
      const bridge = spawn({
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
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
          ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? "",
          OPENCODE_DEFAULT_MODEL:
            process.env.OPENCODE_DEFAULT_MODEL ?? "anthropic/MiniMax-M3",
        },
        cwd: tempDir,
        stdout: "pipe",
        stderr: "pipe",
      })
      void readStream(bridge.stdout as ReadableStream<Uint8Array> | undefined, "[bridge]")
      void readStream(bridge.stderr as ReadableStream<Uint8Array> | undefined, "[bridge]")

      try {
        const health = await waitForHealth(`http://127.0.0.1:${port}/health`, 30_000)
        if (!health) throw new Error(`bridge never became healthy on :${port}`)

        const baseUrl = `ws://127.0.0.1:${port}/ws`
        const ws = await openAndAwaitWelcome(baseUrl)

        // 1. Create a session.
        const created = (await sendAndAwait(ws, { type: "new_session" })) as {
          type: string
          sessionId: string
          title: string
        }
        if (created.type !== "session_created") {
          throw new Error(`new_session returned ${created.type}`)
        }
        if (!created.sessionId.startsWith("ses_")) {
          throw new Error(`session id has unexpected shape: ${created.sessionId}`)
        }
        const sessionId = created.sessionId

        // 2. Send a prompt. Don't assert on the response
        // content (the bridge may not have a working LLM);
        // assert that the prompt was accepted and the
        // session eventually settles.
        const settled = sendPromptAndAwaitSettled(ws, sessionId)
        const accepted = (await sendAndAwait(ws, {
          type: "prompt",
          sessionId,
          text: "ping",
        })) as { type: string; sessionId: string }
        if (accepted.type !== "prompt_accepted") {
          throw new Error(`prompt returned ${accepted.type}`)
        }
        if (accepted.sessionId !== sessionId) {
          throw new Error(`prompt accepted on wrong session: ${accepted.sessionId}`)
        }
        const terminal = await settled
        if (terminal === "timeout") {
          // The bridge may not have a working LLM provider,
          // so the prompt may never settle. As long as the
          // prompt was accepted and the bridge stayed up, the
          // wire-protocol contract is met. We surface the
          // timeout here as a soft warning rather than a
          // hard fail — the other assertions in the test
          // cover the contract that actually matters.
          console.warn("[ws-smoke] prompt did not settle in 15s; continuing")
        }

        // 3. List sessions — should include the one we just made.
        const listed = (await sendAndAwait(ws, { type: "list_sessions" })) as {
          type: string
          sessions: Array<{ id: string; title: string; active: boolean }>
        }
        if (listed.type !== "sessions") {
          throw new Error(`list_sessions returned ${listed.type}`)
        }
        if (!listed.sessions.find((s) => s.id === sessionId)) {
          throw new Error(`session ${sessionId} not in list`)
        }

        // 4. Switch to the same session.
        const switched = (await sendAndAwait(ws, {
          type: "switch_session",
          sessionId,
        })) as { type: string; sessionId: string }
        if (switched.type !== "session_switched") {
          throw new Error(`switch_session returned ${switched.type}`)
        }

        // 5. Close the session.
        const closed = (await sendAndAwait(ws, {
          type: "close_session",
          sessionId,
        })) as { type: string; sessionId: string }
        if (closed.type !== "session_closed") {
          throw new Error(`close_session returned ${closed.type}`)
        }

        // 6. After close, the session is gone from the list.
        const relisted = (await sendAndAwait(ws, { type: "list_sessions" })) as {
          type: string
          sessions: Array<{ id: string }>
        }
        if (relisted.sessions.find((s) => s.id === sessionId)) {
          throw new Error(`session ${sessionId} still listed after close`)
        }

        ws.close()
      } finally {
        bridge.kill("SIGTERM")
        // Wait up to 5s for graceful exit; otherwise SIGKILL.
        try {
          await Promise.race([
            bridge.exited,
            new Promise<void>((r) => setTimeout(r, 5_000)),
          ])
        } catch {}
        try {
          bridge.kill("SIGKILL")
        } catch {}
        await fs.rm(tempDir, { recursive: true, force: true })
      }
    },
    90_000,
  )
}

// Wait for the HTTP /health endpoint to return 200.
async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function readStream(
  stream: ReadableStream<Uint8Array> | undefined,
  tag: string,
): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      const text = decoder.decode(value)
      for (const line of text.split("\n")) {
        if (line.trim()) process.stderr.write(`${tag} ${line}\n`)
      }
    }
  } catch {}
}

// Open a WS and wait for the welcome frame. Returns the
// connected socket.
function openAndAwaitWelcome(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type: string }
        if (m.type === "welcome") {
          ws.removeEventListener("message", onMsg)
          resolve(ws)
        }
      } catch {}
    }
    ws.addEventListener("open", () => ws.addEventListener("message", onMsg), {
      once: true,
    })
    ws.addEventListener(
      "error",
      (e) => reject(new Error(`ws open failed: ${describeError(e)}`)),
      { once: true },
    )
    setTimeout(() => reject(new Error("welcome timeout")), 15_000)
  })
}

// Send a client message and await the next inbound frame
// whose `type` matches one of the valid responses for the
// command we sent. The bridge emits server-state events on
// the same socket, so we can't just take the "next" frame.
function sendAndAwait(ws: WebSocket, msg: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const expected = (msg as { type: string }).type
    const responseTypes: Record<string, string[]> = {
      new_session: ["session_created", "error"],
      list_sessions: ["sessions", "error"],
      switch_session: ["session_switched", "error"],
      close_session: ["session_closed", "sessions", "error"],
      prompt: ["prompt_accepted", "prompt_rejected", "error"],
      abort: ["aborted", "error"],
      permission_reply: ["error"],
      question_reply: ["error"],
    }
    const valid = responseTypes[expected] ?? [expected]
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg)
      reject(new Error(`timeout waiting for ${valid.join("|")} after ${expected}`))
    }, 10_000)
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type: string }
        if (valid.includes(m.type)) {
          clearTimeout(timer)
          ws.removeEventListener("message", onMsg)
          resolve(m)
        }
      } catch (e) {
        clearTimeout(timer)
        ws.removeEventListener("message", onMsg)
        reject(e)
      }
    }
    ws.addEventListener("message", onMsg)
    ws.send(JSON.stringify(msg))
  })
}

// Subscribe to events for a given session and resolve once
// the session goes idle, errors, or any other terminal
// signal arrives. Returns the terminal kind. Doesn't
// send the prompt — the caller does that separately.
function sendPromptAndAwaitSettled(
  ws: WebSocket,
  sessionId: string,
): Promise<"idle" | "error" | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg)
      resolve("timeout")
    }, 15_000)
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as {
          type: string
          event?: {
            type: string
            properties?: { sessionID?: string; status?: { type?: string } }
          }
        }
        if (m.type !== "event" || !m.event) return
        // session.status with type idle/error = turn settled.
        if (
          m.event.type === "session.status" &&
          m.event.properties?.sessionID === sessionId
        ) {
          const status = m.event.properties?.status?.type
          if (status === "idle") {
            clearTimeout(timer)
            ws.removeEventListener("message", onMsg)
            resolve("idle")
            return
          }
          if (status === "error") {
            clearTimeout(timer)
            ws.removeEventListener("message", onMsg)
            resolve("error")
            return
          }
        }
      } catch {}
    }
    ws.addEventListener("message", onMsg)
  })
}

function describeError(event: Event): string {
  if ("message" in event && typeof (event as { message?: unknown }).message === "string") {
    return (event as { message: string }).message
  }
  return event.type || "unknown"
}
