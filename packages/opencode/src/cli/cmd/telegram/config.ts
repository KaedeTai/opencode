import path from "path"
import fs from "fs"
import { Database as BunDB } from "bun:sqlite"
import { getConfigDir, getDbPath } from "./paths"

export type ModelEntry = {
  providerID: string
  modelID: string
  name: string
  contextLimit: number | null
}

// Last-resort fallback used when the server's /config/providers
// endpoint is unreachable. Kept intentionally small — the dynamic
// catalog (built from the server) is the primary source.
const STATIC_FALLBACK: ModelEntry[] = [
  { providerID: "omlx", modelID: "Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-MLX-oQ4-MTP", name: "oMLX · Qwen 3.6 35B", contextLimit: null },
  { providerID: "anthropic", modelID: "MiniMax-M3", name: "MiniMax · MiniMax-M3 (1M ctx, via anthropic route)", contextLimit: 1_000_000 },
  { providerID: "anthropic", modelID: "MiniMax-M2.7-highspeed", name: "MiniMax · MiniMax-M2.7 highspeed", contextLimit: 204_800 },
  { providerID: "anthropic", modelID: "MiniMax-M2.7", name: "MiniMax · MiniMax-M2.7 (200K ctx)", contextLimit: 204_800 },
]

// Per-model context limit overrides for the static fallback. The
// dynamic catalog already carries limits from the server; this map
// is only consulted when the server endpoint is unreachable AND
// the static fallback already lacks a contextLimit.
const STATIC_CONTEXT_LIMITS: Record<string, number> = {
  "MiniMax-M3": 1_000_000,
  "MiniMax-M2.7": 204_800,
  "MiniMax-M2.7-highspeed": 204_800,
  "MiniMax-M2.5": 204_800,
  "MiniMax-M2.1": 204_800,
  "MiniMax-M2": 204_800,
  "MiniMax-M2-her": 65_536,
  "claude-sonnet-4-5": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-6": 200_000,
}

export function getStaticModelCatalog(): ModelEntry[] {
  return STATIC_FALLBACK
}

export function staticContextLimit(modelID: string): number | null {
  return STATIC_CONTEXT_LIMITS[modelID] ?? null
}

// Build the model catalog from the server's /config/providers endpoint.
// Returns the dynamic catalog on success, or the static fallback if
// the server is unreachable. The dynamic catalog is preferred because
// it carries accurate context limits and reflects the user's current
// opencode.json + env configuration.
export async function getModelCatalog(client: any): Promise<ModelEntry[]> {
  try {
    const res = await client.config.providers()
    if (res.error || !res.data) return STATIC_FALLBACK
    const entries: ModelEntry[] = []
    for (const provider of res.data.providers as Array<{
      id: string
      models: Record<string, { id?: string; name: string; limit?: { context?: number } }>
    }>) {
      for (const [modelKey, model] of Object.entries(provider.models)) {
        entries.push({
          providerID: provider.id,
          modelID: model.id ?? modelKey,
          name: model.name,
          contextLimit: model.limit?.context ?? null,
        })
      }
    }
    if (entries.length > 0) return entries
  } catch {}
  return STATIC_FALLBACK
}

// Look up a model's context window size. Tries the dynamic catalog
// first (so it stays in sync with what the server actually exposes),
// then the static context-limit map, then null.
export async function getModelContextLimit(
  client: any,
  providerID: string,
  modelID: string,
): Promise<number | null> {
  const catalog = await getModelCatalog(client)
  const entry = catalog.find((c) => c.providerID === providerID && c.modelID === modelID)
  if (entry?.contextLimit) return entry.contextLimit
  return staticContextLimit(modelID)
}

// Resolve a user query against a catalog. Strict match on
// "providerID/modelID", then prefix/suffix match on modelID,
// then case-insensitive name contains. Returns undefined if no hit.
export function resolveModel(query: string, catalog: ModelEntry[]): ModelEntry | undefined {
  const q = query.trim()
  if (!q) return undefined
  if (q.includes("/")) {
    const [p, m] = q.split("/", 2)
    return catalog.find((c) => c.providerID === p && c.modelID === m)
  }
  const exact = catalog.find((c) => c.modelID === q)
  if (exact) return exact
  const suffix = catalog.find((c) => c.modelID.endsWith(q) || c.modelID.includes(q))
  if (suffix) return suffix
  const lower = q.toLowerCase()
  return catalog.find((c) => c.name.toLowerCase().includes(lower))
}

// Narrow view of the opencode config file. The bot only reads three
// fields: a top-level `model` string and a `provider` record whose
// entries may carry a `model` string. Everything else (theme,
// keybinds, mcp, etc.) is irrelevant to the bot and stays opaque.
type OpencodeConfig = {
  $schema?: string
  model?: string
  provider?: Record<string, { model?: string }>
}

// Get the currently active default model from env or user config.
// Used by /model to mark the current entry with a ✓ in the list and
// by /status to show the active model.
export function getCurrentModel(): { providerID: string; modelID: string } | null {
  const envModel = process.env.OPENCODE_DEFAULT_MODEL
  if (envModel && envModel.includes("/")) {
    const [p, m] = envModel.split("/", 2)
    return { providerID: p, modelID: m }
  }
  if (envModel) {
    return { providerID: process.env.OPENCODE_DEFAULT_PROVIDER ?? "opencode", modelID: envModel }
  }
  // Fall back to the opencode config file. Same probe order as
  // setDefaultModel() below — they must agree on the filename or
  // we write to one and read from the other and silently show
  // "(server default)".
  try {
    const configDir = getConfigDir()
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      const cfgPath = path.join(configDir, name)
      if (!fs.existsSync(cfgPath)) continue
      const raw = fs.readFileSync(cfgPath, "utf8")
      // .jsonc: strip line/block comments before JSON.parse
      const stripped = name.endsWith(".jsonc")
        ? raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
        : raw
      const cfg = JSON.parse(stripped) as OpencodeConfig
      // Prefer the flat `model: "provider/model"` (set by
      // setDefaultModel and by opencode itself). Fall back to
      // scanning the provider Record<providerID, ProviderConfig>
      // for the first entry that has a model.
      const m = cfg.model
      if (m && typeof m === "string") {
        if (m.includes("/")) {
          const [pp, mm] = m.split("/", 2)
          return { providerID: pp, modelID: mm }
        }
        return {
          providerID: process.env.OPENCODE_DEFAULT_PROVIDER ?? "opencode",
          modelID: m,
        }
      }
      if (cfg.provider && typeof cfg.provider === "object") {
        for (const [pid, pcfg] of Object.entries(cfg.provider) as [string, any][]) {
          if (pcfg && typeof pcfg === "object" && typeof pcfg.model === "string") {
            return { providerID: pid, modelID: pcfg.model }
          }
        }
      }
    }
  } catch {}
  return null
}

// Persist a new default provider/model to the opencode config file.
// The server reads opencode.json (or .jsonc) at boot. We probe both
// filenames and only create one if the user has a config dir but no
// config file at all — we don't want to materialize a stale file the
// user never asked for.
export function setDefaultModel(
  providerID: string,
  modelID: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const configDir = getConfigDir()
    // Order matters: opencode.jsonc (json-with-comments, the default
    // for new installs) first, then opencode.json. We don't try
    // config.yaml here — adding yaml deps just for this is overkill
    // and the user can edit the file directly if they're on yaml.
    const candidates = ["opencode.jsonc", "opencode.json"]
    for (const name of candidates) {
      const p = path.join(configDir, name)
      if (!fs.existsSync(p)) continue
      // .jsonc: strip // line comments and /* block comments */
      // before JSON.parse. Cheap and good enough for the config
      // we generate (no // inside string values).
      const raw = fs.readFileSync(p, "utf8")
      const stripped = name.endsWith(".jsonc")
        ? raw
            .replace(/^\s*\/\/.*$/gm, "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
        : raw
      const cfg = JSON.parse(stripped) as OpencodeConfig
      // Opencode config schema: `provider` is a Record<providerID,
      // ProviderConfig> where ProviderConfig has `model` and
      // `options` (no flat `id` field — the key IS the provider id).
      // See packages/core/src/v1/config/provider.ts ProviderConfig.
      // Special case: `anthropic` provider when ANTHROPIC_BASE_URL
      // env is set. The server picks up the provider from the env,
      // so we don't write it into the `provider` map here — just
      // record the default model at top level. Writing a stale
      // `options: { baseURL, apiKey }` would shadow the env.
      if (providerID === "anthropic") {
        cfg.model = `${providerID}/${modelID}`
      } else {
        if (!cfg.provider || typeof cfg.provider !== "object" || Array.isArray(cfg.provider)) {
          cfg.provider = {}
        }
        const existing = cfg.provider[providerID] ?? {}
        cfg.provider[providerID] = { ...existing, model: modelID }
        cfg.model = `${providerID}/${modelID}`
      }
      // Write back. Drop $schema first so we can put it back at
      // the top (the JSON.stringify key order would otherwise
      // re-emit it wherever it happened to be after the spread).
      const schema = cfg.$schema
      delete cfg.$schema
      const ordered: any = schema ? { $schema: schema, ...cfg } : cfg
      fs.writeFileSync(p, JSON.stringify(ordered, null, 2) + "\n")
      return { ok: true }
    }
    // No existing config file — refuse rather than create a new one
    // the user didn't ask for. Tell them what to create.
    return {
      ok: false,
      error: `No opencode.json/opencode.jsonc in ${configDir}. Create one with at least: { "provider": { "${providerID}": { "model": "${modelID}" } } }`,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

export type SessionTokenUsage = {
  total: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  modelContextLimit: number | null
}

// Read the latest assistant message's token usage straight from the
// server's SQLite DB. The server's session.get() doesn't expose
// accumulated token counts (it returns the session struct but not
// a rolled-up total), so we have to query the database directly.
//
// Open-code persists each assistant message's LLM usage in
// message.data.tokens:
//   { total, input, output, reasoning, cache: { read, write } }
//
// WAL mode is on, so we open a separate readonly connection and
// read the latest assistant row by time_created.
//
// TODO(item 11): replace with a server endpoint
//   GET /session/:id/tokens → { total, input, output, reasoning, cache }
// that wraps this DB query server-side. The bot should then call
// via SDK (or direct fetch on the v2 surface) and drop getDbPath
// + the Database import here. Until then this is a stopgap that
// replicates packages/core/src/database/path() inline because the
// bot's process shouldn't pull in the full Database effect layer.
// If the server's schema changes, this will silently return null.
export function getSessionTokens(sessionID: string): SessionTokenUsage | null {
  let db: BunDB | null = null
  try {
    const dbPath = getDbPath()
    if (!fs.existsSync(dbPath)) return null
    // readonly=true forces SQLite to use the WAL shadow file
    // without trying to take a write lock — safe to run while the
    // server is actively writing to the same DB.
    db = new BunDB(dbPath, { readonly: true })
    const row = db
      .query<{
        data: string
      }, [string]>(
        `SELECT data
           FROM message
          WHERE session_id = ? AND data LIKE '%"role":"assistant"%'
          ORDER BY time_created DESC
          LIMIT 1`,
      )
      .get(sessionID)
    if (!row) return null
    const msg = JSON.parse(row.data) as {
      tokens?: {
        total?: number
        input?: number
        output?: number
        reasoning?: number
        cache?: { read?: number; write?: number }
      }
    }
    const t = msg.tokens
    if (!t) return null
    return {
      total: t.total ?? 0,
      input: t.input ?? 0,
      output: t.output ?? 0,
      reasoning: t.reasoning ?? 0,
      cacheRead: t.cache?.read ?? 0,
      cacheWrite: t.cache?.write ?? 0,
      // Caller fills this in from the dynamic catalog after the
      // fact — getSessionTokens stays sync to keep DB access simple.
      modelContextLimit: null,
    }
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {}
  }
}

export * as TelegramConfig from "./config"
