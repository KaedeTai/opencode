// Minimal logger for code paths that run outside an
// Effect runtime. Mirrors the telegram log helper so the
// two bots produce the same log shape.
import { Effect } from "effect"

type Level = "debug" | "info" | "warn" | "error"

const PREFIX = "[websocket]"

function emit(level: Level, msg: string, data?: unknown) {
  if (process.env.OPENCODE_PRINT_LOGS !== "1") return
  const tag = `${PREFIX} [${level}]`
  if (data === undefined) {
    console.error(tag, msg)
    return
  }
  if (data instanceof Error) {
    console.error(tag, msg, data.message)
    return
  }
  try {
    console.error(tag, msg, JSON.stringify(data))
  } catch {
    console.error(tag, msg, String(data))
  }
}

export const log = {
  debug: (msg: string, data?: unknown) => emit("debug", msg, data),
  info: (msg: string, data?: unknown) => emit("info", msg, data),
  warn: (msg: string, data?: unknown) => emit("warn", msg, data),
  error: (msg: string, data?: unknown) => emit("error", msg, data),
}

export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 60_000
export const PING_INTERVAL_MS = 30_000

// Inside an Effect.fn body, prefer yield* Effect.logInfo
// / logError / logDebug so logs go to the file logger.
export { Effect }

export * as WebsocketLog from "./log"
