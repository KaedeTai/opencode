import path from "path"
import fs from "fs"
import { Database as BunDB } from "bun:sqlite"
import { getConfigDir, getDbPath } from "./paths"

// Model catalog for /model. The v2 server has no /config endpoint
// (verified: GET /v2/config → 404, /v1/config → 400), so we can't ask
// the server. Curated to only the providers Kaede uses:
//   oMLX    — local OpenAI-compatible server on :8000, fast local
//             inference on Apple Silicon. Provider id is the literal
//             string "omlx" because the server picks providers up
//             from `provider: { "<id>": {...} }` in opencode.jsonc.
//   anthropic — actually minimax via ANTHROPIC_BASE_URL env
//             (https://api.minimaxi.com/anthropic). When that env is
//             set, the opencode server routes all `anthropic/*`
//             models through minimax's Anthropic-compatible API.
//             So /model has to advertise models under the
//             `anthropic/` provider prefix even though the endpoint
//             is minimax. Model name "MiniMax-M3" is the literal
//             API model id the server forwards.
export type ModelEntry = { providerID: string; modelID: string; name: string }

const KNOWN_PROVIDERS: ModelEntry[] = [
  { providerID: "omlx", modelID: "Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-MLX-oQ4-MTP", name: "oMLX · Qwen 3.6 35B" },
  { providerID: "anthropic", modelID: "MiniMax-M3", name: "MiniMax · MiniMax-M3 (1M ctx, via anthropic route)" },
  { providerID: "anthropic", modelID: "MiniMax-M2.7-highspeed", name: "MiniMax · MiniMax-M2.7 highspeed" },
  { providerID: "anthropic", modelID: "MiniMax-M2.7", name: "MiniMax · MiniMax-M2.7 (200K ctx)" },
]

// Per-model context limits. Used by /status to show a percentage
// readout. Keep in sync with the actual model — wrong values here
// just mislead the user, they don't break anything.
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
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

export function getModelCatalog(): ModelEntry[] {
  return KNOWN_PROVIDERS
}

export function modelContextLimit(modelID: string): number | null {
  return MODEL_CONTEXT_LIMITS[modelID] ?? null
}

// Resolve a user query against the catalog. Strict match on
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
      const cfg = JSON.parse(stripped) as any
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
      const cfg = JSON.parse(stripped) as any
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
// read the latest assistant row by time_created. We also pull the
// model's contextLimit from the provider/model config so the
// percentage readout is meaningful.
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
    // Look up the model's context limit from the live config so
    // the percentage readout means something.
    const cur = getCurrentModel()
    const limit = cur ? modelContextLimit(cur.modelID) : null
    return {
      total: t.total ?? 0,
      input: t.input ?? 0,
      output: t.output ?? 0,
      reasoning: t.reasoning ?? 0,
      cacheRead: t.cache?.read ?? 0,
      cacheWrite: t.cache?.write ?? 0,
      modelContextLimit: limit,
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
