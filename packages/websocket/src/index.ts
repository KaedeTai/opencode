import { createOpencode } from "@opencode-ai/sdk"
import type { GlobalEvent } from "@opencode-ai/sdk"

const PORT = Number.parseInt(process.env.WEBSOCKET_PORT ?? "9999")

console.log("🚀 Starting opencode server...")
const opencode = await createOpencode({
  port: 0,
})
console.log("✅ Opencode server ready")

// Track active connections and their sessions
const clients = new Map<Bun.ServerWebSocket, { id: string; sessionId: string | null }>()

// Global event subscription — forwards events to all connected clients
void (async () => {
  const events = await opencode.client.event.subscribe()
  for await (const event of events.stream) {
    const payload = JSON.stringify({
      type: "event",
      event,
    })
    for (const ws of clients.keys()) {
      ws.send(payload)
    }
  }
})()

const server = Bun.serve({
  port: PORT,

  fetch(req, server) {
    // Check for WebSocket upgrade
    const url = new URL(req.url)
    if (
      req.headers.get("Upgrade") === "websocket" &&
      url.pathname === "/ws"
    ) {
      const ws = server.upgrade(req)
      return
    }

    // Health check / info
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", clients: clients.size })
    }
    if (url.pathname === "/" || url.pathname === "/info") {
      return Response.json({
        name: "opencode-websocket",
        version: "1.0.0",
        wsUrl: `/ws`,
        connectedClients: clients.size,
      })
    }

    return new Response("Not found", { status: 404 })
  },

  websocket: {
    open(ws) {
      const id = crypto.randomUUID()
      // @ts-expect-error - Bun type limitation, data is set at runtime
      ws.data = { id }
      clients.set(ws, { id, sessionId: null })
      console.log(`🔗 Client connected: ${id}`)

      ws.send(JSON.stringify({
        type: "welcome",
        message: "Connected to opencode websocket. Send { \"type\": \"prompt\", \"text\": \"...\" } to start.",
      }))
    },

    message(ws, msg) {
      try {
        const data = JSON.parse(msg.toString())
        handleMessage(ws, data)
      } catch (err) {
        ws.send(JSON.stringify({
          type: "error",
          message: `Invalid JSON: ${err}`,
        }))
      }
    },

    close(ws) {
      const client = clients.get(ws)
      if (client) {
        console.log(`🔌 Client disconnected: ${client.id}`)
      }
      clients.delete(ws)
    },
  },

  idleTimeout: 60,
})

console.log(`⚡️ WebSocket server is running on ws://localhost:${PORT}/ws`)

async function handleMessage(ws: Bun.ServerWebSocket, data: unknown) {
  if (
    typeof data !== "object" ||
    data === null ||
    !("type" in data) ||
    typeof data.type !== "string"
  ) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Invalid message format. Expected { type: string, ... }",
    }))
    return
  }

  const { type } = data

  if (type === "prompt") {
    if (!("text" in data) || typeof data.text !== "string") {
      ws.send(JSON.stringify({
        type: "error",
        message: "Prompt message must include a 'text' field.",
      }))
      return
    }
    await handlePrompt(ws, data.text)
    return
  }

  if (type === "abort") {
    await handleAbort(ws)
    return
  }

  if (type === "new_session") {
    await handleNewSession(ws)
    return
  }

  if (type === "status") {
    return sendStatus(ws)
  }

  ws.send(JSON.stringify({
    type: "error",
    message: `Unknown message type: ${type}. Supported: prompt, abort, new_session, status`,
  }))
}

async function handlePrompt(ws: Bun.ServerWebSocket, text: string) {
  const clientInfo = clients.get(ws)
  if (!clientInfo) return

  if (!clientInfo.sessionId) {
    // Auto-create session
    clientInfo.sessionId = await doCreateSession(ws)
    if (!clientInfo.sessionId) return
  }

  console.log(`📝 Prompt → session ${clientInfo.sessionId}`)
  const result = await opencode.client.session.prompt({
    path: { id: clientInfo.sessionId },
    body: { parts: [{ type: "text", text }] },
  })

  if (result.error) {
    console.error("❌ Prompt failed:", result.error)
    ws.send(JSON.stringify({
      type: "error",
      message: result.error.data?.message ?? "Failed to send prompt.",
    }))
    return
  }

  console.log("✅ Prompt sent")
}

async function handleAbort(ws: Bun.ServerWebSocket) {
  const clientInfo = clients.get(ws)
  if (!clientInfo || !clientInfo.sessionId) {
    ws.send(JSON.stringify({
      type: "error",
      message: "No active session to abort.",
    }))
    return
  }

  const result = await opencode.client.session.abort({
    path: { id: clientInfo.sessionId },
  })

  if (result.error) {
    ws.send(JSON.stringify({
      type: "error",
      message: result.error.data?.message ?? "Failed to abort session.",
    }))
    return
  }

  ws.send(JSON.stringify({
    type: "aborted",
    sessionId: clientInfo.sessionId,
  }))
  console.log(`⏹️ Session ${clientInfo.sessionId} aborted`)
}

async function handleNewSession(ws: Bun.ServerWebSocket) {
  const clientInfo = clients.get(ws)
  if (!clientInfo) return

  clientInfo.sessionId = await doCreateSession(ws)
  if (!clientInfo.sessionId) return

  console.log(`✅ New session created: ${clientInfo.sessionId}`)
}

async function doCreateSession(ws: Bun.ServerWebSocket): Promise<string | null> {
  const createResult = await opencode.client.session.create({
    body: { title: `WebSocket session ${Date.now()}` },
  })

  if (createResult.error) {
    console.error("❌ Failed to create session:", createResult.error)
    ws.send(JSON.stringify({
      type: "error",
      message: "Failed to create session.",
    }))
    return null
  }

  const sessionId = createResult.data.id

  ws.send(JSON.stringify({
    type: "session_created",
    sessionId,
  }))

  // Share session
  const shareResult = await opencode.client.session.share({ path: { id: sessionId } })
  if (!shareResult.error && shareResult.data?.share?.url) {
    ws.send(JSON.stringify({
      type: "session_shared",
      url: shareResult.data.share.url,
    }))
  }

  return sessionId
}

function sendStatus(ws: Bun.ServerWebSocket) {
  const clientInfo = clients.get(ws)
  if (!clientInfo) return

  ws.send(JSON.stringify({
    type: "status",
    sessionId: clientInfo.sessionId,
    connected: true,
  }))
}
