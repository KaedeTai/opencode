// Minimal logger for code paths that run outside an Effect runtime
// (fire-and-forget callbacks, the event-stream IIFE, top-level setup).
// Inside the main Effect.fn body, prefer yield* Effect.logInfo/Error.
//
// Output is gated by OPENCODE_PRINT_LOGS to match the rest of opencode:
// when unset, the bot is silent on stderr (the file logger is for
// Effect-context logs only). When set, we mirror to stderr so the
// operator can see what the bot is doing in real time.

type Level = "debug" | "info" | "warn" | "error"

const PREFIX = "[telegram]"

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

export * as TelegramLog from "./log"
