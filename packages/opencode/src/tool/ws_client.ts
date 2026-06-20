import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./ws_client.txt"

const DEFAULT_TIMEOUT = 60_000
const MAX_TIMEOUT = 5 * 60_000

// Wire-protocol messages we send + accept. Kept narrow on
// purpose: anything the WS bridge emits that we don't use
// here (reasoning, patch summaries, tool calls) is simply
// ignored.
type ClientMessage =
  | { type: "new_session" }
  | { type: "switch_session"; sessionId: string }
  | { type: "prompt"; sessionId?: string; text: string }

type ServerMessage =
  | { type: "welcome"; version: string; serverUrl: string }
  | { type: "session_created"; sessionId: string; title: string; active: boolean }
  | { type: "session_switched"; sessionId: string }
  | { type: "prompt_accepted"; sessionId: string }
  | { type: "prompt_rejected"; sessionId: string; reason: string }
  | { type: "aborted"; sessionId: string }
  | { type: "sessions"; sessions: Array<{ id: string; title: string; active: boolean; inflight: boolean }> }
  | { type: "error"; code: string; message: string; sessionId?: string }
  | { type: "event"; event: { type: string; properties?: unknown } }
  | { type: "pong" }

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "WebSocket URL of the peer opencode (e.g. ws://host:9999/ws)",
  }),
  prompt: Schema.String.annotate({
    description: "The prompt to send to the peer",
  }),
  sessionId: Schema.optional(Schema.String).annotate({
    description: "Optional target session id on the peer. If omitted, a new session is created.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Timeout in seconds (max 300, default 60)",
  }),
})

type Metadata = {
  url: string
  sessionId: string
  durationMs: number
  textChunks: number
  eventsReceived: number
}

export const WsClientTool = Tool.define(
  "ws_client",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("ws://") && !params.url.startsWith("wss://")) {
            throw new Error("url must start with ws:// or wss://")
          }
          const timeoutMs = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Permission gate. Localhost is implicit-allow (the
          // same trust model webfetch uses); anything else
          // asks the user first.
          const isLocal = /^ws:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)?/.test(params.url)
          if (!isLocal) {
            yield* ctx.ask({
              permission: "ws_client",
              patterns: [params.url],
              always: ["ws://localhost*", "ws://127.0.0.1*", "ws://[::1]*"],
              metadata: { url: params.url, prompt: params.prompt.slice(0, 200) },
            })
          }

          const started = Date.now()
          const result = yield* Effect.promise(() => runPrompt(params, timeoutMs))
          const durationMs = Date.now() - started
          yield* ctx.metadata({ metadata: { ...result.metadata, durationMs } })
          return {
            title: `Asked peer @ ${hostOf(params.url)}`,
            output: result.output,
            metadata: { ...result.metadata, durationMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

type RunResult = {
  output: string
  metadata: Metadata
}

async function runPrompt(
  params: Schema.Schema.Type<typeof Parameters>,
  timeoutMs: number,
): Promise<RunResult> {
  return withTimeout(timeoutMs, async () => {
    const ws = await openSocket(params.url)
    try {
      // 1. Wait for the welcome so we know the server is up.
      const welcome = await nextMessage<ServerMessage>(ws, (m) => m.type === "welcome")
      if (welcome.type !== "welcome") {
        throw new Error("peer did not send a welcome")
      }

      // 2. Resolve the target session. Reuse one if the
      // caller named it; otherwise create a fresh one.
      let sessionId: string
      if (params.sessionId) {
        ws.send(JSON.stringify({ type: "switch_session", sessionId: params.sessionId } satisfies ClientMessage))
        const switched = await nextMessage<ServerMessage>(
          ws,
          (m) => m.type === "session_switched" || m.type === "error",
        )
        if (switched.type === "error") {
          throw new Error(`switch_session failed: ${switched.message}`)
        }
        sessionId = (switched as { sessionId: string }).sessionId
      } else {
        ws.send(JSON.stringify({ type: "new_session" } satisfies ClientMessage))
        const created = await nextMessage<ServerMessage>(
          ws,
          (m) => m.type === "session_created" || m.type === "error",
        )
        if (created.type === "error") {
          throw new Error(`new_session failed: ${created.message}`)
        }
        sessionId = (created as { sessionId: string }).sessionId
      }

      // 3. Send the prompt and wait for the server to
      // acknowledge. The actual answer streams in over
      // event messages after this point.
      ws.send(
        JSON.stringify({ type: "prompt", sessionId, text: params.prompt } satisfies ClientMessage),
      )
      const accepted = await nextMessage<ServerMessage>(
        ws,
        (m) =>
          m.type === "prompt_accepted" ||
          m.type === "prompt_rejected" ||
          m.type === "error",
      )
      if (accepted.type === "prompt_rejected") {
        throw new Error(`prompt rejected: ${accepted.reason}`)
      }
      if (accepted.type === "error") {
        throw new Error(`prompt failed: ${accepted.message}`)
      }

      // 4. Stream events until the session goes idle.
      // We accumulate text parts and ignore everything else;
      // tool / reasoning / patch events are summarised into
      // a one-line inline note so the user still sees they
      // happened.
      const textChunks: string[] = []
      const toolNotes: string[] = []
      const reasoningNotes: string[] = []
      const patchNotes: string[] = []
      let eventsReceived = 0
      let lastError: string | null = null
      let done = false

      while (!done) {
        const ev = await nextMessage<ServerMessage>(ws, (m) => true)
        eventsReceived++
        if (ev.type !== "event") continue
        const inner = ev.event
        if (inner.type === "message.part.updated") {
          const part = (inner.properties as { part?: { type?: string; text?: string; sessionID?: string; tool?: string; state?: { title?: string }; files?: Array<{ path: string; additions?: number; deletions?: number }> } })?.part
          if (!part || part.sessionID !== sessionId) continue
          if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
            textChunks.push(part.text)
          } else if (part.type === "tool" && part.state?.title) {
            toolNotes.push(`- ${part.tool}: ${part.state.title}`)
          } else if (part.type === "reasoning" && typeof part.text === "string" && part.text.length > 0) {
            // Reasoning is internal; just note that it
            // happened, don't dump the full thought.
            reasoningNotes.push(`- (${part.text.length} chars)`)
          } else if (part.type === "patch" && Array.isArray(part.files) && part.files.length > 0) {
            for (const f of part.files) {
              patchNotes.push(`- ${f.path} (+${f.additions ?? 0}/-${f.deletions ?? 0})`)
            }
          }
        } else if (inner.type === "session.error") {
          const err = (inner.properties as { error?: { name?: string; message?: string } })?.error
          lastError = err ? `${err.name ?? "Error"}: ${err.message ?? "unknown"}` : "unknown error"
        } else if (inner.type === "session.status") {
          const status = (inner.properties as { sessionID?: string; status?: { type?: string } })?.status
          if (status?.type === "idle") {
            done = true
          }
        }
      }

      // 5. Compose the tool result. Headline is the
      // assistant text; surrounding sections summarise the
      // tool/reasoning/patch activity so the caller knows
      // the peer did more than just generate text.
      const sections: string[] = []
      if (textChunks.length > 0) {
        sections.push(textChunks.join(""))
      }
      if (toolNotes.length > 0) {
        sections.push(`\n\n<peer_tools>\n${toolNotes.join("\n")}\n</peer_tools>`)
      }
      if (patchNotes.length > 0) {
        sections.push(`\n\n<peer_patches>\n${patchNotes.join("\n")}\n</peer_patches>`)
      }
      if (reasoningNotes.length > 0) {
        sections.push(`\n\n<peer_reasoning>\n${reasoningNotes.join("\n")}\n</peer_reasoning>`)
      }
      if (lastError) {
        sections.push(`\n\n<peer_error>\n${lastError}\n</peer_error>`)
      }
      if (sections.length === 0) {
        sections.push("(peer returned no text or events)")
      }

      return {
        output: sections.join(""),
        metadata: {
          url: params.url,
          sessionId,
          durationMs: 0, // filled by caller
          textChunks: textChunks.length,
          eventsReceived,
        },
      }
    } finally {
      try {
        ws.close()
      } catch {}
    }
  })
}

// Bun's WebSocket has a `close(code, reason)` that throws
// if the socket is already closed — wrap in try/catch at
// the call site so the cleanup path is idempotent.

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(url)
    const onOpen = () => {
      if (settled) return
      settled = true
      ws.removeEventListener("error", onError)
      resolve(ws)
    }
    const onError = (event: Event) => {
      if (settled) return
      settled = true
      ws.removeEventListener("open", onOpen)
      reject(new Error(`ws connection failed: ${describeError(event)}`))
    }
    ws.addEventListener("open", onOpen, { once: true })
    ws.addEventListener("error", onError, { once: true })
  })
}

function nextMessage<T extends ServerMessage>(
  ws: WebSocket,
  predicate: (m: ServerMessage) => boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      let parsed: ServerMessage
      try {
        parsed = JSON.parse(String(event.data)) as ServerMessage
      } catch (e) {
        // Malformed frame — keep listening, the next
        // message might be the one we want.
        return
      }
      if (parsed.type === "pong") return
      if (!predicate(parsed)) return
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
      resolve(parsed as T)
    }
    const onError = (event: Event) => {
      ws.removeEventListener("message", onMessage)
      reject(new Error(`ws error: ${describeError(event)}`))
    }
    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
  })
}

function describeError(event: Event): string {
  if ("message" in event && typeof (event as { message?: unknown }).message === "string") {
    return (event as { message: string }).message
  }
  return event.type || "unknown"
}

async function withTimeout<T>(ms: number, body: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ws_client timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([body(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
