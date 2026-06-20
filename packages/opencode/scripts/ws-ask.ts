// Send a research prompt to the keep-alive sub-agent and stream back the result.
//
// Usage: bun run scripts/ws-ask.ts "<prompt>"
// Reads bridge connection from /tmp/sub-agent-keepalive/state.json.

import fs from "node:fs/promises"

const STATE_FILE = "/tmp/sub-agent-keepalive/state.json"
const prompt = process.argv.slice(2).join(" ").trim()
if (!prompt) {
  console.error("usage: bun run scripts/ws-ask.ts <prompt>")
  process.exit(2)
}

const state = JSON.parse(await Bun.file(STATE_FILE).text()) as {
  wsUrl: string
  pid: number
  port: number
}

// Reuse a single session if we previously created one, else make new
const SESSION_FILE = "/tmp/sub-agent-keepalive/session.json"
let sessionId: string | null = null
try {
  const s = JSON.parse(await Bun.file(SESSION_FILE).text()) as { sessionId: string }
  sessionId = s.sessionId
} catch {}

const ws = new WebSocket(state.wsUrl)
const tag = "[sub-agent]"
const flush = (s: string) => process.stdout.write(s)

await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("welcome timeout")), 10_000)
  ws.addEventListener("open", () => {
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data)) as { type: string }
      if (m.type === "welcome") { clearTimeout(t); resolve() }
    })
  })
})

if (!sessionId) {
  ws.send(JSON.stringify({ type: "new_session" }))
  const created = (await new Promise<any>((resolve) => {
    const t = setTimeout(() => resolve(null), 8_000)
    ws.addEventListener("message", function on(ev) {
      const m = JSON.parse(String(ev.data)) as any
      if (m.type === "session_created") { clearTimeout(t); ws.removeEventListener("message", on); resolve(m) }
    })
  })) as { sessionId: string } | null
  if (!created) throw new Error("new_session timeout")
  sessionId = created.sessionId
  await Bun.write(SESSION_FILE, JSON.stringify({ sessionId }))
}
flush(`${tag} session: ${sessionId}\n`)

const start = Date.now()
let lastStatus: string | null = null
const textPieces: string[] = []
let active = false
const final = new Promise<string>((resolve) => {
  const t = setTimeout(() => resolve(textPieces.join("") || "(timeout)"), 600_000) // 10 min cap
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data)) as any
    if (m.type === "event" && m.event) {
      const e = m.event
      if (e.type === "message.part.updated") {
        const p = e.properties?.part
        if (p?.sessionID !== sessionId) return
        if (p.type === "text" && typeof p.text === "string") {
          active = true
          textPieces.push(p.text)
          flush(p.text)
        } else if (p.type === "tool") {
          const name = p.tool ?? "?"
          const st = typeof p.state === "string" ? p.state : JSON.stringify(p.state ?? {})
          flush(`\n${tag} 🔧 ${name} ${st}\n`)
        }
      } else if (e.type === "session.status" && active) {
        const st = e.properties?.status?.type
        if (lastStatus !== st) { lastStatus = st; flush(`\n${tag} status=${st}\n`) }
        if (st === "idle" || st === "error") { clearTimeout(t); resolve(textPieces.join("")) }
      }
    }
  })
})

ws.send(JSON.stringify({ type: "prompt", sessionId, text: prompt }))
flush(`${tag} (prompt sent, waiting up to 10 min)\n`)
flush("─".repeat(72) + "\n")

const reply = await final
const elapsed = ((Date.now() - start) / 1000).toFixed(1)
flush("\n" + "─".repeat(72) + "\n")
flush(`${tag} done in ${elapsed}s, ${textPieces.length} text parts, ${reply.length} chars\n`)
ws.close()
