import type { GlobalEvent } from "@opencode-ai/sdk"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { log, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from "./log"

// Run a persistent event-stream loop that forwards every
// opencode event to all connected WebSocket clients. Owns
// its own exponential-backoff reconnect state so a brief
// server hiccup doesn't drop the bridge.
//
// Returns a stop() function the caller invokes during
// shutdown to break the loop and close the stream.
export function startEventForwarder(opts: {
  client: OpencodeClient
  // Called once per event with the JSON payload ready to
  // ship to every WS client. The forwarder stays
  // transport-agnostic — it doesn't know about WebSockets.
  send: (payload: string) => void
}) {
  let reconnectAttempts = 0
  let stopped = false
  let current: { close: () => void } | null = null

  void (async () => {
    while (!stopped) {
      try {
        log.debug("connecting event stream")
        const events = await opts.client.event.subscribe()
        reconnectAttempts = 0
        log.debug("event stream connected")
        // Tee the events through a small AbortController so
        // stop() can close the stream without waiting for
        // the next event.
        const ac = new AbortController()
        current = { close: () => ac.abort() }
        for await (const event of events.stream as AsyncIterable<GlobalEvent>) {
          if (stopped) break
          if (ac.signal.aborted) break
          try {
            opts.send(JSON.stringify({ type: "event", event }))
          } catch (e) {
            log.error("event forward send", { message: eMsg(e) })
          }
        }
        current = null
      } catch (err) {
        if (stopped) break
        const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts)
        const jitter = base * 0.3 * Math.random()
        const delay = Math.round(base + jitter)
        reconnectAttempts++
        log.warn("event stream disconnected, reconnecting", {
          attempt: reconnectAttempts,
          delayMs: delay,
          message: eMsg(err),
        })
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  })()

  return () => {
    stopped = true
    current?.close()
  }
}

const eMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
