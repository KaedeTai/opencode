import path from "path"
import fs from "fs"
import os from "os"
import { Global } from "@opencode-ai/core/global"

export function getSessionsFile(): string {
  return path.join(Global.Path.data, "telegram-sessions.json")
}

// Same DB path logic as @opencode-ai/core/database/path(). Replicated
// here to avoid pulling the whole Database effect layer (and its
// boot-time side effects) into the bot.
export function getDbPath(): string {
  const dataDir = Global.Path.data
  const flagOverride = process.env.OPENCODE_DB
  if (flagOverride) {
    return flagOverride === ":memory:" || flagOverride.startsWith("/")
      ? flagOverride
      : path.join(dataDir, flagOverride)
  }
  // The bot's channel is whatever InstallationChannel resolves to
  // at build time. On dev/checkout installs it ends up in
  // "opencode-dev.db"; on prod it's "opencode.db". We probe both
  // (dev first, since that's what the dev binary writes).
  const candidates = [
    path.join(dataDir, "opencode-dev.db"),
    path.join(dataDir, "opencode.db"),
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]
}

export function getConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode")
}

export * as TelegramPaths from "./paths"
