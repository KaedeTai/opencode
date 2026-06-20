import type { OpencodeClient } from "@opencode-ai/sdk"
import {
  activeSession,
  addSession,
  newClient,
  removeSession,
  setActive,
  toSummary,
  type ClientState,
  type ClientSession,
} from "./sessions"
import { log, PING_INTERVAL_MS } from "./log"
import type { ClientMessage, ServerMessage } from "./protocol"

export type { ClientState, ClientSession } from "./sessions"

// Build the Bun.serve handler. Takes the SDK client, the
// set of currently-connected clients (so the event
// forwarder can `send` to all of them), and returns the
// `Bun.serve` options plus a `broadcast` helper the
// forwarder can call.
//
// Bun's WebSocket handler shape is intentionally
// untyped, so we keep `any` here for the per-socket data
// and cast at the boundary.
export function buildServer(opts: {
  client: OpencodeClient
  baseUrl: string
  clients: Set<unknown>
  port: number
  hostname: string
  version: string
  onShutdown?: (ws: unknown) => void
}) {
  // send a JSON message to a single client. Throws on
  // serialization error so the caller can log + drop the
  // dead client.
  const sendTo = (ws: unknown, msg: ServerMessage) => {
    ;(ws as { send: (data: string) => void }).send(JSON.stringify(msg))
  }

  const onConnection = (ws: unknown) => {
    const id = crypto.randomUUID()
    const state = newClient(id)
    ;(ws as { data: unknown }).data = state
    opts.clients.add(ws)
    log.debug("client connected", { id, total: opts.clients.size })
    sendTo(ws, { type: "welcome", version: opts.version, serverUrl: opts.baseUrl })
  }

  const onClose = (ws: unknown) => {
    opts.clients.delete(ws)
    const state = (ws as { data?: ClientState }).data
    log.debug("client disconnected", { id: state?.id, total: opts.clients.size })
    opts.onShutdown?.(ws)
  }

  const onMessage = async (ws: unknown, raw: unknown) => {
    const state = (ws as { data?: ClientState }).data
    if (!state) {
      log.warn("message on untracked client")
      return
    }
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw)) as ClientMessage
    } catch (e) {
      sendTo(ws, { type: "error", code: "invalid_message", message: eMsg(e) })
      return
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      sendTo(ws, { type: "error", code: "invalid_message", message: "missing or invalid 'type' field" })
      return
    }
    try {
      await handleMessage(state, msg, ws, sendTo, opts.client, opts.baseUrl)
    } catch (e) {
      const message = eMsg(e)
      log.error("message handler crashed", { type: msg.type, message })
      sendTo(ws, { type: "error", code: "internal", message, sessionId: extractSessionId(msg) })
    }
  }

  return {
    clients: opts.clients,
    // The forwarder uses this to ship an event payload to
    // every connected client.
    broadcast: (payload: string) => {
      for (const ws of opts.clients) {
        try {
          ;(ws as { send: (data: string) => void }).send(payload)
        } catch (e) {
          log.error("broadcast send", { message: eMsg(e) })
        }
      }
    },
    fetch(req: Request, server: { upgrade: (req: Request, opts?: unknown) => unknown }) {
      const url = new URL(req.url)
      if (req.headers.get("Upgrade") === "websocket" && url.pathname === "/ws") {
        server.upgrade(req)
        return
      }
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", clients: opts.clients.size })
      }
      if (url.pathname === "/" || url.pathname === "/info") {
        return Response.json({
          name: "opencode-websocket",
          version: opts.version,
          wsUrl: "/ws",
          connectedClients: opts.clients.size,
        })
      }
      return new Response("Not found", { status: 404 })
    },
    websocket: {
      open: onConnection,
      message: onMessage,
      close: onClose,
    },
  }
}

// Dispatch a single client message. All side effects go
// through `sendTo`; nothing here touches the socket
// directly.
async function handleMessage(
  state: ClientState,
  msg: ClientMessage,
  ws: unknown,
  sendTo: (ws: unknown, msg: ServerMessage) => void,
  client: OpencodeClient,
  baseUrl: string,
): Promise<void> {
  switch (msg.type) {
    case "ping":
      sendTo(ws, { type: "pong" })
      return

    case "new_session": {
      const res = await client.session.create({ body: { title: msg.title } })
      if (res.error || !res.data) {
        sendTo(ws, { type: "error", code: "session_create_failed", message: errorMessage(res.error) })
        return
      }
      const session = {
        id: res.data.id,
        title: res.data.title ?? msg.title ?? "(untitled)",
        inflight: false,
      }
      addSession(state, session)
      sendTo(ws, {
        type: "session_created",
        sessionId: session.id,
        title: session.title,
        active: true,
      })
      sendTo(ws, { type: "sessions", sessions: toSummary(state) })
      return
    }

    case "list_sessions":
      sendTo(ws, { type: "sessions", sessions: toSummary(state) })
      return

    case "switch_session":
      if (!state.sessions.has(msg.sessionId)) {
        sendTo(ws, { type: "error", code: "session_not_found", message: msg.sessionId })
        return
      }
      setActive(state, msg.sessionId)
      sendTo(ws, { type: "session_switched", sessionId: msg.sessionId })
      return

    case "close_session": {
      if (!state.sessions.has(msg.sessionId)) {
        sendTo(ws, { type: "error", code: "session_not_found", message: msg.sessionId })
        return
      }
      // Server-side delete is best-effort; even if it 404s
      // (e.g. already deleted) we still drop it locally.
      await client.session.delete({ path: { id: msg.sessionId } }).catch(() => undefined)
      removeSession(state, msg.sessionId)
      sendTo(ws, { type: "session_closed", sessionId: msg.sessionId })
      sendTo(ws, { type: "sessions", sessions: toSummary(state) })
      return
    }

    case "abort": {
      const target = msg.sessionId ? state.sessions.get(msg.sessionId) : activeSession(state)
      if (!target) {
        sendTo(ws, { type: "error", code: "session_not_found", message: msg.sessionId ?? "(no active session)" })
        return
      }
      await client.session.abort({ path: { id: target.id } }).catch(() => undefined)
      target.inflight = false
      sendTo(ws, { type: "aborted", sessionId: target.id })
      return
    }

    case "permission_reply": {
      const pending = state.pendingPermission
      if (!pending) {
        sendTo(ws, { type: "error", code: "invalid_message", message: "no pending permission" })
        return
      }
      // Map the WS client's three-way reply to the server's
      // permission response shape.
      const response: "once" | "always" | "reject" = msg.response
      const r = await client.postSessionIdPermissionsPermissionId({
        path: { id: pending.sessionId, permissionID: pending.permissionId },
        body: { response },
      }).catch((e) => ({ error: e }))
      if ((r as { error?: unknown }).error) {
        sendTo(ws, {
          type: "error",
          code: "internal",
          message: eMsg((r as { error: unknown }).error),
          sessionId: pending.sessionId,
        })
        return
      }
      state.pendingPermission = undefined
      return
    }

    case "question_reply": {
      const questions = state.pendingQuestions
      if (!questions || questions.size === 0) {
        sendTo(ws, { type: "error", code: "invalid_message", message: "no pending question" })
        return
      }
      // The server schema is `Array<Question.Answer>` (one
      // slot per question, each slot is a string[]). The
      // client sends `string[][]` where the inner array
      // length matches the number of questions. We pair
      // them up by questionId.
      const r = await fetch(`${baseUrl}/question/${msg.questionId}/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": encodeURIComponent(process.cwd()),
        },
        body: JSON.stringify({ answers: msg.answers }),
      }).catch((e) => ({ error: e }))
      if (!r || (r as { ok?: boolean }).ok === false) {
        sendTo(ws, {
          type: "error",
          code: "internal",
          message: `question reply failed: ${eMsg((r as { error?: unknown }).error ?? r)}`,
        })
        return
      }
      questions.delete(msg.questionId)
      if (questions.size === 0) state.pendingQuestions = undefined
      return
    }

    case "prompt": {
      // Resolve the target session. If the client specified
      // one, use it (creating if needed); otherwise use the
      // active session, creating one if there isn't one.
      let target = msg.sessionId ? state.sessions.get(msg.sessionId) : activeSession(state)
      if (!target) {
        const res = await client.session.create({ body: { title: msg.text.slice(0, 80) } })
        if (res.error || !res.data) {
          sendTo(ws, { type: "error", code: "session_create_failed", message: errorMessage(res.error) })
          return
        }
        target = {
          id: res.data.id,
          title: res.data.title ?? msg.text.slice(0, 80),
          inflight: false,
        }
        addSession(state, target)
        sendTo(ws, {
          type: "session_created",
          sessionId: target.id,
          title: target.title,
          active: true,
        })
      }

      // Build prompt parts. Attachments are sent as
      // file parts with a data: URI prefix; text is sent
      // as a text part. Same shape the SDK accepts as
      // `parts` in `session.promptAsync`.
      const parts: Array<Record<string, unknown>> = []
      const text = msg.text?.trim()
      if (text) parts.push({ type: "text", text })
      for (const att of msg.attachments ?? []) {
        parts.push({
          type: "file",
          mime: att.mime,
          filename: att.filename,
          url: `data:${att.mime};base64,${att.data}`,
        })
      }
      const result = await client.session.promptAsync({
        path: { id: target.id },
        body: { parts: parts as never[] },
      })
      if (result.error) {
        sendTo(ws, {
          type: "error",
          code: "prompt_failed",
          message: errorMessage(result.error),
          sessionId: target.id,
        })
        return
      }
      target.inflight = true
      sendTo(ws, { type: "prompt_accepted", sessionId: target.id })
      return
    }
  }
}

// Wire up opencode's own event stream to per-client
// permission/question tracking. We mirror the structure
// the telegram bot uses (record-then-reply) so a WS
// client can answer permissions and questions the same
// way a chat user would click a button.
export function applyEvent(state: ClientState, event: { type: string; properties?: unknown }, sendTo: (ws: unknown, msg: ServerMessage) => void): void {
  if (event.type === "session.status") {
    const props = event.properties as { sessionID?: string; status?: { type?: string } } | undefined
    const sid = props?.sessionID
    if (!sid) return
    const target = state.sessions.get(sid)
    if (!target) return
    if (props?.status?.type === "idle") {
      target.inflight = false
      target.lastSent = undefined
    } else if (props?.status?.type === "busy" || props?.status?.type === "retry") {
      target.inflight = true
    }
    return
  }
  if (event.type === "permission.asked") {
    const props = event.properties as { id?: string; sessionID?: string } | undefined
    if (!props?.id || !props.sessionID) return
    if (!state.sessions.has(props.sessionID)) return
    state.pendingPermission = {
      permissionId: props.id,
      sessionId: props.sessionID,
    }
    return
  }
  if (event.type === "question.asked") {
    const props = event.properties as { id?: string; sessionID?: string } | undefined
    if (!props?.id || !props.sessionID) return
    if (!state.sessions.has(props.sessionID)) return
    if (!state.pendingQuestions) state.pendingQuestions = new Map()
    state.pendingQuestions.set(props.id, { questionId: props.id, sessionId: props.sessionID })
    return
  }
  if (event.type === "session.error") {
    // Reset the session's inflight so the client can
    // send another prompt. Otherwise the busy guard
    // would refuse.
    const props = event.properties as { sessionID?: string } | undefined
    const sid = props?.sessionID
    if (!sid) return
    const target = state.sessions.get(sid)
    if (target) target.inflight = false
    return
  }
  // Suppress the "unused parameter" lint — sendTo is
  // here so future event types can reply directly to the
  // client without changing the signature.
  void sendTo
}

const eMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function errorMessage(error: unknown): string {
  if (!error) return "unknown"
  if (typeof error === "string") return error
  if (typeof error !== "object") return String(error)
  const e = error as { data?: { message?: string }; message?: string }
  return e.data?.message ?? e.message ?? "unknown"
}

function extractSessionId(msg: ClientMessage | { sessionId?: unknown }): string | undefined {
  const id = (msg as { sessionId?: unknown }).sessionId
  return typeof id === "string" ? id : undefined
}

// Heartbeat: ping every PING_INTERVAL_MS, drop clients
// that don't respond. Returns a stop() that cancels the
// interval.
export function startHeartbeat(
  ws: unknown,
  isAlive: { alive: boolean },
  onDead: () => void,
): () => void {
  const handle = setInterval(() => {
    if (!isAlive.alive) {
      try {
        ;(ws as { close: () => void }).close()
      } catch {}
      onDead()
      return
    }
    isAlive.alive = false
    try {
      ;(ws as { send: (data: string) => void }).send(JSON.stringify({ type: "ping" }))
    } catch {}
  }, PING_INTERVAL_MS)
  return () => clearInterval(handle)
}

export function markAlive(state: { alive: boolean }): void {
  state.alive = true
}
