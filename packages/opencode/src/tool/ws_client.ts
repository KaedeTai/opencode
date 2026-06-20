import { Effect, Schema } from "effect"
import { spawn, type Subprocess } from "bun"
import * as Tool from "./tool"
import * as BackgroundJob from "@/background/job"
import type { TaskPromptOps } from "./task"
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
  | {
      type: "permission_reply"
      permissionId: string
      response: "once" | "always" | "reject"
    }

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
      "@deprecated Use `background: true` instead. Same semantics: fire-and-forget, auto-injects the result into your context when the peer finishes. Kept for backward compatibility with existing callers.",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Fire-and-forget mode. Sends the prompt to the peer, then returns immediately. When the peer finishes, the result is auto-injected into your context as a synthetic message — no polling needed. Recommended for long-running research or model-isolation tasks where you want to keep working in parallel. The result file at ~/.config/opencode/peer-tasks/<task_id>.json is still written for external observers (humans, scripts in other processes), but the agent should NOT read it — just continue with other work and the result will arrive. Mutually exclusive with taskId.",
  }),
  taskId: Schema.optional(Schema.String).annotate({
    description:
      "@deprecated Polling a detached task by id is no longer the recommended flow — `background: true` auto-injects. Kept for external scripts and for polling tasks started by other processes. Mutually exclusive with prompt/url/sessionId.",
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

          // `background: true` is the new name; `detached: true` is
          // the legacy alias. Both run the same path: spawn a
          // BackgroundJob that talks to the peer, then auto-inject
          // the result into the parent session's context when it
          // completes. The result file is still written for external
          // observers (humans, scripts in other processes).
          const runInBackground = (params.background ?? params.detached ?? false) === true

          if (runInBackground) {
            const taskId = crypto.randomUUID()
            const resultFile = path.join(TASK_DIR, `${taskId}.json`)
            yield* Effect.promise(() => fs.mkdir(TASK_DIR, { recursive: true }))

            // The job's `run` is an in-process Effect — replaces
            // the old Bun.spawn worker. Output is the peer's
            // text; failures land in info.error. The result
            // file is written for external observers but is no
            // longer the primary delivery channel.
            //
            // The run also self-injects the peer's text into the
            // parent session via ops.prompt({ noReply: true }) once
            // the WS round-trip completes. We bypass
            // BackgroundJob.promote's onPromote callback because the
            // current architecture never fires it for background jobs
            // (see packages/opencode/src/server/routes/instance/
            // httpapi/handlers/experimental.ts:158 — the
            // sessionBackground endpoint that triggers promote only
            // matches task-type jobs that are not yet background, and
            // requires OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).
            // Self-injecting inside the run avoids the dead code
            // path and works the same way for any background-tool
            // type.
            const run = buildDetachedRunEffect(ctx, taskId, resolved, resultFile)
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
              title: `Background task @ ${hostOf(url)} (${taskId.slice(0, 8)})`,
              output: BACKGROUND_STARTED(taskId, url, resultFile, params.detached === true),
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
          const result = yield* runPrompt(resolved, ctx)
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

// Effect-based runPrompt. Returns an Effect so `ctx.ask` inside the
// permission relay runs against the parent's runtime + services — the
// previous Promise-based version called `Effect.runPromise(ctx.ask(...))`
// which fell off the parent's Effect context and silently failed with a
// default-deny, producing bogus `<peer_permissions>` "reject" lines for
// requests the user never saw.
function runPrompt(params: ResolvedParams, ctx: Tool.Context): Effect.Effect<RunResult, Error> {
  return Effect.gen(function* () {
    const ws = yield* openSocket(params.url)

    const work = Effect.gen(function* () {
      // 1. Wait for the welcome so we know the server is up.
      const welcome = yield* nextMessage(ws, (m) => m.type === "welcome")
      if (welcome.type !== "welcome") {
        return yield* Effect.fail(new Error("peer did not send a welcome"))
      }

      // 2. Resolve the target session. Reuse one if the
      // caller named it (or we persisted one); otherwise
      // create a fresh one.
      const sessionId: string = yield* Effect.gen(function* () {
        if (!params.sessionId) {
          ws.send(JSON.stringify({ type: "new_session" } satisfies ClientMessage))
          const created = yield* nextMessage(
            ws,
            (m) => m.type === "session_created" || m.type === "error",
          )
          if (created.type === "error") {
            return yield* Effect.fail(new Error(`new_session failed: ${created.message}`))
          }
          return (created as { sessionId: string }).sessionId
        }
        ws.send(
          JSON.stringify({ type: "switch_session", sessionId: params.sessionId } satisfies ClientMessage),
        )
        const switched = yield* nextMessage(
          ws,
          (m) => m.type === "session_switched" || m.type === "error",
        )
        if (switched.type === "error") {
          // Persisted session is gone (bridge restarted, etc).
          // Fall through to creating a new one rather than fail.
          ws.send(JSON.stringify({ type: "new_session" } satisfies ClientMessage))
          const created = yield* nextMessage(
            ws,
            (m) => m.type === "session_created" || m.type === "error",
          )
          if (created.type === "error") {
            return yield* Effect.fail(new Error(`new_session failed: ${created.message}`))
          }
          return (created as { sessionId: string }).sessionId
        }
        return (switched as { sessionId: string }).sessionId
      })

      // 3. Send the prompt and wait for the server to
      // acknowledge. The actual answer streams in over
      // event messages after this point.
      ws.send(
        JSON.stringify({ type: "prompt", sessionId, text: params.prompt } satisfies ClientMessage),
      )
      const accepted = yield* nextMessage(
        ws,
        (m) =>
          m.type === "prompt_accepted" || m.type === "prompt_rejected" || m.type === "error",
      )
      if (accepted.type === "prompt_rejected") {
        return yield* Effect.fail(new Error(`prompt rejected: ${accepted.reason}`))
      }
      if (accepted.type === "error") {
        return yield* Effect.fail(new Error(`prompt failed: ${accepted.message}`))
      }

      // 4. Stream events until the session goes idle.
      const acc = yield* runEventLoop(ws, sessionId, ctx)

      // 5. Compose the tool result. Headline is the
      // assistant text; surrounding sections summarise the
      // tool/reasoning/patch/permission activity so the
      // caller knows the peer did more than just generate text.
      const sections: string[] = []
      if (acc.textChunks.length > 0) sections.push(acc.textChunks.join(""))
      if (acc.toolNotes.length > 0) {
        sections.push(`\n\n<peer_tools>\n${acc.toolNotes.join("\n")}\n</peer_tools>`)
      }
      if (acc.patchNotes.length > 0) {
        sections.push(`\n\n<peer_patches>\n${acc.patchNotes.join("\n")}\n</peer_patches>`)
      }
      if (acc.reasoningNotes.length > 0) {
        sections.push(`\n\n<peer_reasoning>\n${acc.reasoningNotes.join("\n")}\n</peer_reasoning>`)
      }
      if (acc.permissionNotes.length > 0) {
        sections.push(`\n\n<peer_permissions>\n${acc.permissionNotes.join("\n")}\n</peer_permissions>`)
      }
      if (acc.lastError) {
        sections.push(`\n\n<peer_error>\n${acc.lastError}\n</peer_error>`)
      }
      if (sections.length === 0) sections.push("(peer returned no text or events)")

      return {
        output: sections.join(""),
        metadata: {
          url: params.url,
          sessionId,
          durationMs: 0, // filled by caller
          textChunks: acc.textChunks.length,
          eventsReceived: acc.eventsReceived,
        },
      }
    })

    return yield* work.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          try {
            ws.close()
          } catch {}
        }),
      ),
      Effect.timeoutOrElse({
        duration: `${params.timeoutMs} millis`,
        orElse: () => Effect.fail(new Error(`ws_client timed out after ${params.timeoutMs}ms`)),
      }),
    )
  })
}

type EventAccumulator = {
  textChunks: string[]
  toolNotes: string[]
  reasoningNotes: string[]
  patchNotes: string[]
  permissionNotes: string[]
  eventsReceived: number
  lastError: string | null
}

const emptyAcc = (): EventAccumulator => ({
  textChunks: [],
  toolNotes: [],
  reasoningNotes: [],
  patchNotes: [],
  permissionNotes: [],
  eventsReceived: 0,
  lastError: null,
})

// One iteration of the event loop. Either consumes the next message
// (advancing the accumulator) and recurses, or returns when the peer
// goes idle. Permission events are handled inline so `ctx.ask` runs
// against the parent Effect context — critical for the permission UI
// to actually surface.
function runEventLoop(
  ws: WebSocket,
  sessionId: string,
  ctx: Tool.Context,
): Effect.Effect<EventAccumulator, Error> {
  const step = (acc: EventAccumulator): Effect.Effect<EventAccumulator, Error> =>
    Effect.gen(function* () {
      const ev = yield* nextMessage(ws, () => true)
      acc.eventsReceived++
      if (ev.type !== "event") return yield* step(acc)
      const inner = ev.event
      if (inner.type === "message.part.updated") {
        const part = (inner.properties as {
          part?: {
            type?: string
            text?: string
            sessionID?: string
            tool?: string
            state?: { title?: string }
            files?: Array<{ path: string; additions?: number; deletions?: number }>
          }
        })?.part
        if (part && part.sessionID === sessionId) {
          if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
            acc.textChunks.push(part.text)
          } else if (part.type === "tool" && part.state?.title) {
            acc.toolNotes.push(`- ${part.tool}: ${part.state.title}`)
          } else if (
            part.type === "reasoning" &&
            typeof part.text === "string" &&
            part.text.length > 0
          ) {
            acc.reasoningNotes.push(`- (${part.text.length} chars)`)
          } else if (part.type === "patch" && Array.isArray(part.files) && part.files.length > 0) {
            for (const f of part.files) {
              acc.patchNotes.push(`- ${f.path} (+${f.additions ?? 0}/-${f.deletions ?? 0})`)
            }
          }
        }
      } else if (inner.type === "session.error") {
        const err = (inner.properties as { error?: { name?: string; message?: string } })?.error
        acc.lastError = err
          ? `${err.name ?? "Error"}: ${err.message ?? "unknown"}`
          : "unknown error"
      } else if (inner.type === "session.status") {
        const status = (inner.properties as { sessionID?: string; status?: { type?: string } })?.status
        if (status?.type === "idle") return acc
      } else if (inner.type === "permission.asked") {
        // The peer wants to do something that hits the permission wall.
        // Pause the stream, surface it to the parent so the user sees
        // ONE prompt, then relay the decision back over the same
        // socket. The bridge stores one in-flight permission per client,
        // so we process these strictly sequentially.
        const req = (inner.properties ?? {}) as {
          id?: string
          sessionID?: string
          permission?: string
          patterns?: string[]
          metadata?: Record<string, unknown>
          always?: string[]
        }
        if (!req.id || !req.permission) {
          acc.permissionNotes.push(`- skipped malformed permission.asked`)
          return yield* step(acc)
        }
        const decision: "once" | "reject" = yield* ctx
          .ask({
            permission: req.permission,
            patterns: req.patterns ?? [],
            metadata: {
              ...(req.metadata ?? {}),
              peerSessionID: req.sessionID,
              peerPermissionID: req.id,
            },
            always: req.always ?? [],
          })
          .pipe(
            Effect.as("once" as const),
            Effect.catchCause(() => Effect.succeed("reject" as const)),
          )
        ws.send(
          JSON.stringify({
            type: "permission_reply",
            permissionId: req.id,
            response: decision,
          } satisfies ClientMessage),
        )
        const pattern = (req.patterns ?? []).join(", ") || "*"
        acc.permissionNotes.push(`- ${req.permission} ${decision}: ${pattern}`)
      }
      return yield* step(acc)
    })
  return step(emptyAcc())
}

// Bun's WebSocket has a `close(code, reason)` that throws
// if the socket is already closed — wrap in try/catch at
// the call site so the cleanup path is idempotent.

function openSocket(url: string): Effect.Effect<WebSocket, Error> {
  return Effect.callback<WebSocket, Error>((resume) => {
    let settled = false
    const ws = new WebSocket(url)
    const onOpen = () => {
      if (settled) return
      settled = true
      ws.removeEventListener("error", onError)
      resume(Effect.succeed(ws))
    }
    const onError = (event: Event) => {
      if (settled) return
      settled = true
      ws.removeEventListener("open", onOpen)
      resume(Effect.fail(new Error(`ws connection failed: ${describeError(event)}`)))
    }
    ws.addEventListener("open", onOpen, { once: true })
    ws.addEventListener("error", onError, { once: true })
    return Effect.sync(() => {
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
    })
  })
}

function nextMessage<T extends ServerMessage>(
  ws: WebSocket,
  predicate: (m: ServerMessage) => boolean,
): Effect.Effect<T, Error> {
  return Effect.callback<T, Error>((resume) => {
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
      resume(Effect.succeed(parsed as T))
    }
    const onError = (event: Event) => {
      ws.removeEventListener("message", onMessage)
      resume(Effect.fail(new Error(`ws error: ${describeError(event)}`)))
    }
    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
    return Effect.sync(() => {
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
    })
  })
}

function describeError(event: Event): string {
  if ("message" in event && typeof (event as { message?: unknown }).message === "string") {
    return (event as { message: string }).message
  }
  return event.type || "unknown"
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
  ctx: Tool.Context,
  taskId: string,
  params: ResolvedParams,
  resultFile: string,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    yield* Effect.sync(() =>
      fs.appendFile("/tmp/ws_client-debug.log", `[run] start jobId=${taskId.slice(0, 8)} ctx.sessionID=${ctx.sessionID.slice(0, 8)} hasOps=${Boolean(ctx.extra?.promptOps)}\n`).catch(() => {}),
    )
    const started = Date.now()
    const result = yield* runPrompt(params, ctx)
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
    yield* Effect.sync(() =>
      fs.appendFile("/tmp/ws_client-debug.log", `[run] ws done jobId=${taskId.slice(0, 8)} durationMs=${durationMs} — calling inject\n`).catch(() => {}),
    )

    // Self-inject the peer's text into the parent session. Runs
    // here (inside the BackgroundJob's run) instead of via
    // onPromote because the existing promotion path doesn't fire
    // for background-mode jobs — see the long comment at the
    // background.start call site.
    //
    // noReply: true writes the synthetic message into the session
    // but does NOT start a new agent-loop turn (prompt.ts:1122).
    // The user sees the injected text on their NEXT prompt, which
    // is the natural flow — we don't want the bot to suddenly
    // start typing on its own because a background peer finished.
    yield* injectPeerResultSelf(result, ctx, params, taskId)
    yield* Effect.sync(() =>
      fs.appendFile("/tmp/ws_client-debug.log", `[run] inject returned jobId=${taskId.slice(0, 8)}\n`).catch(() => {}),
    )

    return result.output
  }).pipe(
    Effect.tapError((e: unknown) => {
      const writeErrorFile = Effect.promise(() =>
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
      )
      const writeErrorInject = Effect.gen(function* () {
        // On failure, also push an error-state synthetic message
        // so the agent knows the peer didn't come back.
        yield* injectPeerErrorSelf(ctx, params, taskId, e)
      })
      return Effect.all([writeErrorFile, writeErrorInject], { discard: true })
    }),
  )
}

// Self-inject helper for the success path. Mirrors injectPeerResult
// but uses noReply: true so the agent loop stays idle until the user
// prompts again. Safe to call while the parent session is busy —
// noReply bypasses the agent loop start path that enforces single-turn.
const injectPeerResultSelf = (
  result: RunResult,
  ctx: Tool.Context,
  params: ResolvedParams,
  taskId: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
    yield* Effect.sync(() =>
      fs.appendFile("/tmp/ws_client-debug.log", `[inject] enter jobId=${taskId.slice(0, 8)} hasOps=${Boolean(ops)}\n`).catch(() => {}),
    )
    if (!ops) return
    yield* Effect.sync(() =>
      fs.appendFile("/tmp/ws_client-debug.log", `[inject] calling ops.prompt jobId=${taskId.slice(0, 8)} sessionID=${ctx.sessionID.slice(0, 8)}\n`).catch(() => {}),
    )
    const out = yield* ops
      .prompt({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        noReply: true,
        parts: [
          {
            type: "text",
            synthetic: true,
            text: renderPeerOutput({
              taskId,
              url: params.url,
              sessionId: params.sessionId ?? "",
              state: "completed",
              text: result.output,
            }),
          },
        ],
      })
      .pipe(Effect.ignore)
    yield* Effect.sync(() =>
      fs.appendFile("/tmp/ws_client-debug.log", `[inject] ops.prompt returned jobId=${taskId.slice(0, 8)} out=${JSON.stringify(out).slice(0, 200)}\n`).catch(() => {}),
    )
  })

const injectPeerErrorSelf = (
  ctx: Tool.Context,
  params: ResolvedParams,
  taskId: string,
  error: unknown,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
    if (!ops) return
    yield* ops
      .prompt({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        noReply: true,
        parts: [
          {
            type: "text",
            synthetic: true,
            text: renderPeerOutput({
              taskId,
              url: params.url,
              sessionId: params.sessionId ?? "",
              state: "error",
              text: "",
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      })
      .pipe(Effect.ignore)
  })

// Message shown to the agent right after a background task is launched.
// Steers the LLM away from polling/sleeping/duplicating (same shape
// as TaskTool.BACKGROUND_STARTED in task.ts).
const BACKGROUND_STARTED = (
  taskId: string,
  url: string,
  resultFile: string,
  legacyDetached: boolean,
): string => {
  const lines = [
    "Background peer task started. The peer's response will be auto-injected into your context when it finishes — DO NOT sleep, poll, ask for status, or duplicate this work.",
    `  task_id:     ${taskId}`,
    `  url:         ${url}`,
    `  result file: ${resultFile}  (for external observers; you should not read it)`,
  ]
  if (legacyDetached) {
    lines.push(
      `  legacy poll: ws_client({ taskId: "${taskId}", timeout: <seconds> })  (deprecated — prefer waiting for the auto-injected message)`,
    )
  }
  lines.push(
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  )
  return lines.join("\n")
}

// Format the synthetic message that lands in the parent session.
// Uses an XML-ish wrapper so downstream parsing (or a model reading
// it later) can tell the message apart from a regular user prompt.
function renderPeerOutput(input: {
  taskId: string
  url: string
  sessionId: string
  state: "completed" | "error"
  text: string
  error?: string
}): string {
  const head = `<ws_peer id="${input.taskId.slice(0, 8)}" url="${input.url}" session="${input.sessionId.slice(0, 8)}" state="${input.state}">`
  if (input.state === "error") {
    return [head, `  <error>${input.error ?? "unknown"}</error>`, "</ws_peer>"].join("\n")
  }
  return [head, `  <result>`, input.text, `  </result>`, "</ws_peer>"].join("\n")
}
