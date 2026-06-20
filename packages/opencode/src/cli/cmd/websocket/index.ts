import { Effect } from "effect"
import type { Argv } from "yargs"
import { UI } from "../../ui"
import { effectCmd, fail } from "../../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../../network"
import type { NetworkOptions } from "../../network"
import { buildServer, applyEvent, startHeartbeat, markAlive, type ClientState } from "./server"
import { startEventForwarder } from "./events"
import { log } from "./log"

type WebsocketArgs = NetworkOptions & {
  port?: number
  readonly _: Array<string | number>
}

const WS_VERSION = "1.0.0"

export const WebsocketCommand = effectCmd({
  command: "websocket",
  aliases: ["ws"],
  describe: "start opencode server with a WebSocket bridge for custom frontends",
  instance: false,
  builder: (yargs: Argv) =>
    withNetworkOptions(yargs)
      .option("port", {
        type: "number",
        describe: "WebSocket bridge port (or WEBSOCKET_PORT env var, default 9999)",
        default: 9999,
      })
      .check((argv) => {
        const port = argv.port
        if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`--port must be an integer in 0..65535, got: ${String(port)}`)
        }
        return true
      }),
  handler: Effect.fn("Cli.websocket")(function* (rawArgs) {
    const args = rawArgs as unknown as WebsocketArgs

    // ── Boot the opencode server first ─────────────────────
    // Same pattern as the telegram bot: bring the opencode
    // server up in-process, then attach the WS bridge to
    // it via the SDK. This means `opencode websocket` is a
    // single binary that doesn't need a separate
    // `opencode serve` running.
    const { Server } = yield* Effect.promise(() => import("../../../server/server"))
    const netOpts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(netOpts))
    yield* Effect.logInfo("websocket server up", { url: server.url.toString() })

    // ── SDK client (over the loopback server) ────────────
    const { createOpencodeClient } = yield* Effect.promise(() => import("@opencode-ai/sdk"))
    const client = createOpencodeClient({ baseUrl: server.url.toString() })
    yield* Effect.logDebug("websocket SDK client created")

    // ── WS bridge state ──────────────────────────────────
    // Set of currently-connected Bun.ServerWebSocket. The
    // event forwarder broadcasts to every member; the
    // per-socket ClientState lives on `ws.data`.
    const clients = new Set<unknown>()
    const port = args.port ?? Number.parseInt(process.env.WEBSOCKET_PORT ?? "9999")
    const hostname = args.hostname ?? "127.0.0.1"

    const built = buildServer({
      client,
      baseUrl: server.url.toString(),
      clients,
      port,
      hostname,
      version: WS_VERSION,
    })

    // ── Event stream forwarder ───────────────────────────
    // The forwarder doesn't know about Bun — it just calls
    // `built.broadcast(payload)` for every opencode event.
    // Owns its own reconnect loop with exponential backoff.
    const stopForwarder = startEventForwarder({
      client,
      send: (payload) => {
        // `payload` is a JSON string. For every client we
        // also run the per-client `applyEvent` hook so
        // permission/question tracking and inflight state
        // stay in sync with what the SDK says.
        for (const ws of clients) {
          try {
            const state = (ws as { data?: ClientState }).data
            if (state) {
              // We could parse once and reuse, but the
              // overhead is negligible vs. the network
              // round-trip. Parse here so the typed event
              // reaches the per-client hook.
              const parsed = JSON.parse(payload) as { type: string; event?: { type: string; properties?: unknown } }
              if (parsed.type === "event" && parsed.event) {
                applyEvent(state, parsed.event, (w, m) => {
                  try {
                    ;(w as { send: (data: string) => void }).send(JSON.stringify(m))
                  } catch (e) {
                    log.error("apply event reply", { message: eMsg(e) })
                  }
                })
              }
            }
          } catch (e) {
            log.error("per-client event hook", { message: eMsg(e) })
          }
          try {
            ;(ws as { send: (data: string) => void }).send(payload)
          } catch (e) {
            log.error("broadcast send", { message: eMsg(e) })
          }
        }
      },
    })

    // ── Heartbeats ───────────────────────────────────────
    // Per-client liveness: each WS gets a flag, a ping
    // interval, and a dead-connection callback. Pongs
    // arrive via the message handler; see `markAlive`.
    // We don't need a separate `ws.data.alive` field
    // because ClientState is small enough; but the
    // heartbeat helpers expect a `{ alive: boolean }`
    // so we wrap on the side.
    const heartbeats = new Map<unknown, () => void>()
    // We don't expose a "ready" event from buildServer, so
    // attach the heartbeat in fetch via upgrade. Easier:
    // override the onConnection path here. (The fetch /
    // websocket handlers are plain functions, not bound
    // to Bun.serve yet, so we wrap them once.)
    const onConnection = built.websocket.open
    built.websocket.open = (ws: unknown) => {
      ;(onConnection as (w: unknown) => void)(ws)
      const liveness = { alive: true }
      const stop = startHeartbeat(ws, liveness, () => {
        try {
          ;(ws as { close: () => void }).close()
        } catch {}
        clients.delete(ws)
        heartbeats.delete(ws)
      })
      heartbeats.set(ws, stop)
      // Patch send so pongs reset the flag. The
      // message handler in server.ts will call
      // markAlive({ alive: true }) via the wrapper.
      const origSend = (ws as { send: (data: string) => void }).send.bind(ws)
      ;(ws as { send: (data: string) => void }).send = (data: string) => {
        try {
          const parsed = JSON.parse(data) as { type?: string }
          if (parsed.type === "ping") {
            // Don't count our own pings against the
            // client's aliveness. Only the client's
            // pongs do.
          }
        } catch {}
        return origSend(data)
      }
    }
    // Patch message handler to mark alive on pong. The
    // simpler approach: hook into onMessage's `markAlive`
    // is not exposed, so we intercept pongs in the
    // broadcast path. Instead, we read the raw inbound
    // here by re-binding the message handler.
    const onMessage = built.websocket.message
    built.websocket.message = async (ws: unknown, raw: unknown) => {
      try {
        const parsed = JSON.parse(String(raw)) as { type?: string }
        if (parsed.type === "pong") {
          markAlive({ alive: true })
          return
        }
      } catch {}
      await (onMessage as (w: unknown, m: unknown) => Promise<void>)(ws, raw)
    }

    // ── Bun.serve ────────────────────────────────────────
    // Bun's WebSocket handler types are tightly bound to its
    // own Server generic. We construct the options as
    // `any`-typed locals so the function signatures don't
    // leak into Bun's inference — see `server.ts` for the
    // real types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchHandler: any = built.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wsHandler: any = built.websocket
    const wsServer = Bun.serve({
      port,
      hostname,
      fetch: fetchHandler,
      websocket: wsHandler,
    })

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    UI.println(UI.Style.TEXT_INFO_BOLD + "  OpenCode:     ", UI.Style.TEXT_NORMAL, server.url.toString())
    UI.println(UI.Style.TEXT_INFO_BOLD + "  WebSocket:    ", UI.Style.TEXT_NORMAL, `ws://${hostname}:${port}/ws`)
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Health:       ", UI.Style.TEXT_NORMAL, `http://${hostname}:${port}/health`)
    UI.empty()

    // ── Graceful shutdown ────────────────────────────────
    const cleanup = () => {
      for (const stop of heartbeats.values()) stop()
      heartbeats.clear()
      for (const ws of clients) {
        try {
          ;(ws as { close: () => void }).close()
        } catch {}
      }
      clients.clear()
      stopForwarder()
      try {
        wsServer.stop(true)
      } catch {}
    }
    process.once("SIGINT", cleanup)
    process.once("SIGTERM", cleanup)

    // Keep the process alive — the WS server runs in the
    // background and the event forwarder is fire-and-forget.
    yield* Effect.never
  }),
})

const eMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export * as Websocket from "."
