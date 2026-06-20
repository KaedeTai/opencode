import { Effect, Schema } from "effect"
import { spawn, type Subprocess } from "bun"
import * as Tool from "./tool"
import * as BackgroundJob from "@/background/job"
import DESCRIPTION from "./ws_client.txt"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

const DEFAULT_TIMEOUT = 60_000
const MAX_TIMEOUT = 5 * 60_000

// Default peer URL. Override with WEBSOCKET_BRIDGE_URL when the bridge is
// running on a non-default port or host. The bridge is the long-lived
// `opencode websocket` process spawned by scripts/ws-spawn-keepalive.ts.
const DEFAULT_URL = process.env.WEBSOCKET_BRIDGE_URL ?? "ws://127.0.0.1:9999/ws"

// On the opencode host we keep a single "last used" session id so repeated
// calls inside the same workspace share the peer's context (history,
// working dir, etc.) without the caller having to track it.
const SESSION_FILE = path.join(os.homedir(), ".config", "opencode", "peer-session.json")

// Where detached (fire-and-forget) tasks write their result. The file name
// is the task id; the agent reads it back with the `read` tool when it's
// ready to look at the result.
const TASK_DIR = path.join(os.homedir(), ".config", "opencode", "peer-tasks")

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
  url: Schema.optional(Schema.String).annotate({
    description:
      "WebSocket URL of the peer opencode. Defaults to $WEBSOCKET_BRIDGE_URL or ws://127.0.0.1:9999/ws. Start the bridge once with `bun run scripts/ws-spawn-keepalive.ts` and it stays up between calls.",
  }),
  prompt: Schema.String.annotate({
    description: "The prompt to send to the peer.",
  }),
  sessionId: Schema.optional(Schema.String).annotate({
    description:
      "Optional target session id on the peer. If omitted, the last-used session from ~/.config/opencode/peer-session.json is reused, or a new session is created.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Timeout in seconds (max 300, default 60). Ignored when detached=true.",
  }),
  detached: Schema.optional(Schema.Boolean).annotate({
    description:
      "Fire-and-forget mode. Starts a background job via opencode's BackgroundJob registry, returns a task_id immediately. The job's final output is also written to ~/.config/opencode/peer-tasks/<task_id>.json for external observers. Fetch the result later by calling ws_client again with taskId=<id> (and optionally timeout + wait).",
  }),
  taskId: Schema.optional(Schema.String).annotate({
    description:
      "Fetch the result of a previously-started detached task. Blocks up to `timeout` seconds (default 60, max 300). If the task is still running, returns a 'still running' message — call again with a longer timeout. Mutually exclusive with prompt/url/sessionId.",
  }),
  autoStart: Schema.optional(Schema.Boolean).annotate({
    description:
      "If true and the bridge isn't reachable, spawn it in the background (same as running scripts/ws-spawn-keepalive.ts) and wait for /health. Default false; the tool will surface a clear error if the bridge is down.",
  }),
})

type Metadata = {
  url: string
  sessionId: string
  durationMs: number
  textChunks: number
  eventsReceived: number
  detached?: boolean
  taskId?: string
  resultFile?: string
}

type ResolvedParams = {
  url: string
  prompt: string
  sessionId?: string
  timeoutMs: number
  detached: boolean
  autoStart: boolean
}

export const WsClientTool = Tool.define(
  "ws_client",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // taskId path: wait for a previously-started detached job.
          // Mutually exclusive with the prompt path.
          if (params.taskId) {
            if (params.prompt || params.url || params.sessionId) {
              return yield* Effect.fail(
                new Error("taskId is mutually exclusive with prompt/url/sessionId"),
              )
            }
            const waitMs = Math.min(
              (params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000,
              MAX_TIMEOUT,
            )
            const result = yield* background.wait({ id: params.taskId, timeout: waitMs })
            if (result.timedOut) {
              return {
                title: `Peer task ${params.taskId.slice(0, 8)} still running`,
                output:
                  `Background task is still running after ${waitMs / 1000}s. ` +
                  `Call ws_client again with taskId=${params.taskId} and a longer timeout.`,
                metadata: {
                  url: "",
                  sessionId: "",
                  durationMs: waitMs,
                  textChunks: 0,
                  eventsReceived: 0,
                  taskId: params.taskId,
                },
              }
            }
            const info = result.info
            const meta = (info?.metadata ?? {}) as Record<string, unknown>
            const text = info?.output ?? ""
            const status = info?.status ?? "unknown"
            return {
              title: `Peer task ${params.taskId.slice(0, 8)} ${status}`,
              output: text || `(task ${status}, no output)`,
              metadata: {
                url: (meta.url as string) ?? "",
                sessionId: (meta.sessionId as string) ?? "",
                durationMs: (meta.durationMs as number) ?? 0,
                textChunks: (meta.textChunks as number) ?? 0,
                eventsReceived: (meta.eventsReceived as number) ?? 0,
              },
            }
          }

          const url = resolveUrl(params.url)
          if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
            throw new Error(`url must start with ws:// or wss://, got: ${url}`)
          }
          const timeoutMs = Math.min(
            (params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000,
            MAX_TIMEOUT,
          )

          // Permission gate. Localhost is implicit-allow (the
          // same trust model webfetch uses); anything else
          // asks the user first.
          const isLocal = /^ws:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)?/.test(url)
          if (!isLocal) {
            yield* ctx.ask({
              permission: "ws_client",
              patterns: [url],
              always: ["ws://localhost*", "ws://127.0.0.1*", "ws://[::1]*"],
              metadata: { url, prompt: params.prompt.slice(0, 200) },
            })
          }

          const resolved: ResolvedParams = {
            url,
            prompt: params.prompt,
            sessionId: params.sessionId ?? (yield* Effect.promise(() => loadPersistedSession())),
            timeoutMs,
            detached: params.detached ?? false,
            autoStart: params.autoStart ?? false,
          }

          if (resolved.detached) {
            const taskId = crypto.randomUUID()
            const resultFile = path.join(TASK_DIR, `${taskId}.json`)
            yield* Effect.promise(() => fs.mkdir(TASK_DIR, { recursive: true }))

            // The job's `run` is an in-process Effect — replaces
            // the old Bun.spawn worker. Output is the peer's
            // text; failures land in info.error. The result
            // file is written for external observers but is no
            // longer the primary delivery channel.
            const run = buildDetachedRunEffect(resolved, resultFile)
            yield* background.start({
              id: taskId,
              type: "ws_client",
              title: `Peer @ ${hostOf(url)}`,
              metadata: {
                url,
                prompt: resolved.prompt.slice(0, 200),
                sessionId: resolved.sessionId,
              },
              run,
            })
            return {
              title: `Detached task @ ${hostOf(url)} (${taskId.slice(0, 8)})`,
              output:
                `Detached task started.\n` +
                `  task_id:     ${taskId}\n` +
                `  result:      ${resultFile}\n` +
                `  url:         ${url}\n` +
                `  wait via:    ws_client({ taskId: "${taskId}", timeout: <seconds> })\n` +
                `The peer is running in the background. Continue with other work; call ws_client again with taskId to fetch the result.`,
              metadata: {
                url,
                sessionId: resolved.sessionId ?? "(will be created)",
                durationMs: 0,
                textChunks: 0,
                eventsReceived: 0,
                detached: true,
                taskId,
                resultFile,
              },
            }
          }

          // Sync path: optionally auto-start the bridge.
          if (resolved.autoStart && !(yield* Effect.promise(() => isReachable(url)))) {
            spawnBridge(url)
            if (!(yield* Effect.promise(() => waitForReachable(url, 30_000)))) {
              throw new Error(
                `bridge at ${url} did not become healthy in 30s after autoStart; ` +
                  `try running scripts/ws-spawn-keepalive.ts manually to see errors`,
              )
            }
          }

          const started = Date.now()
          const result = yield* Effect.promise(() => runPrompt(resolved))
          const durationMs = Date.now() - started

          // Persist the resolved session so future calls reuse it.
          // Skip when the caller explicitly named a session — they may
          // be doing one-off work and shouldn't pollute the default.
          if (!params.sessionId) {
            yield* Effect.promise(() => savePersistedSession(result.metadata.sessionId))
          }

          yield* ctx.metadata({ metadata: { ...result.metadata, durationMs } })
          return {
            title: `Asked peer @ ${hostOf(url)}`,
            output: result.output,
            metadata: { ...result.metadata, durationMs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function resolveUrl(input: string | undefined): string {
  return input && input.length > 0 ? input : DEFAULT_URL
}

async function loadPersistedSession(): Promise<string | undefined> {
  try {
    const data = JSON.parse(await fs.readFile(SESSION_FILE, "utf-8")) as { sessionId?: string }
    return typeof data.sessionId === "string" ? data.sessionId : undefined
  } catch {
    return undefined
  }
}

async function savePersistedSession(sessionId: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SESSION_FILE), { recursive: true })
    await fs.writeFile(
      SESSION_FILE,
      JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2),
    )
  } catch {
    // best-effort; never fail the tool call because of persistence
  }
}

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

async function runPrompt(params: ResolvedParams): Promise<RunResult> {
  return withTimeout(params.timeoutMs, async () => {
    const ws = await openSocket(params.url)
    try {
      // 1. Wait for the welcome so we know the server is up.
      const welcome = await nextMessage<ServerMessage>(ws, (m) => m.type === "welcome")
      if (welcome.type !== "welcome") {
        throw new Error("peer did not send a welcome")
      }

      // 2. Resolve the target session. Reuse one if the
      // caller named it (or we persisted one); otherwise
      // create a fresh one.
      let sessionId: string
      if (params.sessionId) {
        ws.send(JSON.stringify({ type: "switch_session", sessionId: params.sessionId } satisfies ClientMessage))
        const switched = await nextMessage<ServerMessage>(
          ws,
          (m) => m.type === "session_switched" || m.type === "error",
        )
        if (switched.type === "error") {
          // Persisted session is gone (bridge restarted, etc).
          // Fall through to creating a new one rather than fail.
          ws.send(JSON.stringify({ type: "new_session" } satisfies ClientMessage))
          const created = await nextMessage<ServerMessage>(
            ws,
            (m) => m.type === "session_created" || m.type === "error",
          )
          if (created.type === "error") {
            throw new Error(`new_session failed: ${created.message}`)
          }
          sessionId = (created as { sessionId: string }).sessionId
        } else {
          sessionId = (switched as { sessionId: string }).sessionId
        }
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
      } catch {
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

function isReachable(url: string): Promise<boolean> {
  const httpUrl = url.replace(/^ws/, "http").replace(/\/ws$/, "/health")
  return fetch(httpUrl, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false)
}

async function waitForReachable(url: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await isReachable(url)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

// Auto-start the bridge from the tool. Spawns the same process that
// scripts/ws-spawn-keepalive.ts would, but inlined here so the dist
// binary doesn't depend on the source tree at runtime. The child
// becomes a session leader and survives tool completion.
function spawnBridge(url: string): Subprocess {
  const port = urlPort(url)
  return spawn({
    cmd: [process.execPath, "websocket", "--ws-port", String(port), "--hostname", "127.0.0.1"],
    env: { ...process.env, OPENCODE_PRINT_LOGS: "0" },
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  })
}

function urlPort(url: string): number {
  try {
    return new URL(url).port ? parseInt(new URL(url).port, 10) : 9999
  } catch {
    return 9999
  }
}

// Detached (fire-and-forget) path. Builds an in-process Effect
// that does the same WS interaction as runPrompt, writes the
// result to a file for external observers, and returns the
// peer's text as the job's output. BackgroundJob.start runs the
// Effect in the parent process — no subprocess, no polling.
// The main call returns a task_id immediately; the agent uses
// ws_client({ taskId }) to wait.
function buildDetachedRunEffect(
  params: ResolvedParams,
  resultFile: string,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const started = Date.now()
    const result = yield* Effect.promise(() => runPrompt(params))
    const durationMs = Date.now() - started
    const payload = {
      ok: true,
      sessionId: result.metadata.sessionId,
      url: result.metadata.url,
      durationMs,
      textChunks: result.metadata.textChunks,
      eventsReceived: result.metadata.eventsReceived,
      text: result.output,
      finishedAt: new Date().toISOString(),
    }
    yield* Effect.promise(() =>
      fs.writeFile(resultFile, JSON.stringify(payload, null, 2)).catch(() => undefined),
    )
    return result.output
  }).pipe(
    Effect.tapError((e: unknown) =>
      Effect.promise(() =>
        fs
          .writeFile(
            resultFile,
            JSON.stringify(
              {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
                finishedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          )
          .catch(() => undefined),
      ),
    ),
  )
}
