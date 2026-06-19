import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import type { NetworkOptions } from "../network"
import path from "path"
import fs from "fs"
import os from "os"
import { Global } from "@opencode-ai/core/global"
import { Database as BunDB } from "bun:sqlite"

type TelegramArgs = NetworkOptions & {
  token?: string
  allowedUsers?: string
  readonly _: Array<string | number>
}

export const TelegramCommand = effectCmd({
  command: "telegram",
  aliases: ["tg"],
  describe: "start opencode server with Telegram bot interface",
  instance: false,
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("token", {
        type: "string",
        describe: "Telegram bot token (or set TELEGRAM_BOT_TOKEN env var)",
      })
      .option("allowed-users", {
        type: "string",
        describe: "comma-separated list of allowed chat IDs (or set TELEGRAM_ALLOWED_USERS, empty = allow all)",
      }),
  handler: Effect.fn("Cli.telegram")(function* (rawArgs) {
    const args = rawArgs as TelegramArgs
    console.error("[telegram] handler start")

    // ── Resolve bot token ──────────────────────────────────────────
    const token = args.token ?? process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
      return yield* fail(
        "Telegram bot token is required.\n" +
          "  Set TELEGRAM_BOT_TOKEN env var, or pass --token.\n" +
          "  Get one from: https://t.me/BotFather",
      )
    }
    console.error("[telegram] token resolved")

    const allowedUsers = (args.allowedUsers ?? process.env.TELEGRAM_ALLOWED_USERS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean)
    console.error("[telegram] allowedUsers:", allowedUsers)

    // ── Start server ──────────────────────────────────────────────
    console.error("[telegram] importing server...")
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    console.error("[telegram] resolving network options...")
    const opts = yield* resolveNetworkOptions(args)
    console.error("[telegram] starting server...")
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.error("[telegram] server started at", server.url.toString())

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Server:       ", UI.Style.TEXT_NORMAL, server.url.toString())

    // ── SDK client ────────────────────────────────────────────────
    console.error("[telegram] creating SDK client...")
    const { createOpencodeClient } = yield* Effect.promise(() => import("@opencode-ai/sdk"))
    const client = createOpencodeClient({ baseUrl: server.url.toString() })
    console.error("[telegram] SDK client created")

    // ── Telegraf bot ──────────────────────────────────────────────
    console.error("[telegram] importing Telegraf...")
    const { Telegraf, Markup } = yield* Effect.promise(() => import("telegraf"))
    console.error("[telegram] Telegraf imported, creating bot...")
    // handlerTimeout default in Telegraf is 90s. Our command handlers
    // do fire-and-forget dispatch via `safe()`, so a single command
    // should resolve within milliseconds. A 90s window is dangerous:
    // if anything inside the handler awaits a slow network call
    // (Telegram API, opencode SDK), the whole long-poll cycle freezes
    // for 90s, the bot appears unresponsive, and the next user
    // message queues up behind the stuck one. 5s is plenty for our
    // handlers — anything slower than that almost certainly is the
    // Telegram API itself, which we don't want to block polling on.
    const bot = new Telegraf(token, { handlerTimeout: 5_000 }) as any
    console.error("[telegram] bot created")

    // ── Global error handler ──────────────────────────────────────
    bot.catch((err: any, ctx: any) => {
      console.error("[telegram] unhandled error:", err?.message ?? err, "ctx:", ctx?.updateType ?? "unknown")
    })

    // ── Helpers ───────────────────────────────────────────────────
    function safe(fn: () => Promise<void>, label: string) {
      fn().catch((e: any) => console.error(`[telegram] ${label}:`, e?.message ?? e))
    }

    async function createSession(chatId: string) {
      try {
        const res = await client.session.create({ body: { title: `Telegram ${chatId}` } })
        if (res.error) return null
        const sessionId = res.data.id
        sessions.set(chatId, { sessionId, lastSent: null, lastReasoning: null, userPrompt: null, streamMsgId: null, inflight: false })
        persistSessions()
        return sessionId
      } catch (e: any) {
        console.error("[telegram] createSession error:", e?.message ?? e)
        return null
      }
    }


    function chatOf(sessionId: string): string | null {
      for (const [cid, s] of sessions.entries()) {
        if (s.sessionId === sessionId) return cid
      }
      return null
    }

    function allow(chatId: string): boolean {
      return allowedUsers.length === 0 || allowedUsers.includes(chatId)
    }

    function trunc(s: string, n: number) {
      return s.length > n ? s.slice(0, n - 3) + "..." : s
    }

    async function send(cid: string, msg: string) {
      if (!msg || !msg.trim()) return
      try {
        await bot.telegram.sendMessage(cid, trunc(msg, 4000))
      } catch (e: any) {
        console.error("[telegram] send error:", e?.message ?? e)
      }
    }

    // ── Streaming editor: edit the in-flight assistant message in
    // place, or send a new one and remember its id. Skips the round-trip
    // when the new text is identical to what we last wrote (Telegram
    // also rejects no-op edits).
    async function editOrSend(s: SessionState, cid: string, text: string) {
      if (!text || !text.trim()) return
      const body = trunc(text, 4000)
      if (s.streamMsgId == null) {
        try {
          const m = await bot.telegram.sendMessage(cid, body)
          s.streamMsgId = m?.message_id ?? null
        } catch (e: any) {
          console.error("[telegram] stream start error:", e?.message ?? e)
        }
        return
      }
      try {
        await bot.telegram.editMessageText(cid, s.streamMsgId, undefined, body)
      } catch (e: any) {
        const msg = String(e?.message ?? e)
        // "message is not modified" is harmless — content already matches.
        if (msg.includes("not modified")) return
        // Edit can fail if Telegram thinks the message is too old or the
        // text is identical; fall back to a fresh message.
        console.error("[telegram] stream edit failed, sending new:", msg)
        try {
          const m = await bot.telegram.sendMessage(cid, body)
          s.streamMsgId = m?.message_id ?? null
        } catch (e2: any) {
          console.error("[telegram] stream fallback send error:", e2?.message ?? e2)
        }
      }
    }

    // Close the stream — next text part starts a new message. We don't
    // delete the old one, just drop our handle.
    function closeStream(s: SessionState) {
      s.streamMsgId = null
    }

    // ── Typing indicator ──────────────────────────────────────────
    // Telegram expires the "typing" chat action after ~5s, so we
    // re-send it every 4s while a session is busy.
    const typingTimers = new Map<string, ReturnType<typeof setInterval>>()
    function startTyping(cid: string) {
      if (typingTimers.has(cid)) return
      const tick = () => {
        bot.telegram
          .sendChatAction(cid, "typing")
          .catch((e: any) => console.error("[telegram] sendChatAction error:", e?.message ?? e))
      }
      tick()
      typingTimers.set(cid, setInterval(tick, 4000))
    }
    function stopTyping(cid: string) {
      const t = typingTimers.get(cid)
      if (t) {
        clearInterval(t)
        typingTimers.delete(cid)
      }
    }

    // ── Media: download from Telegram + transcribe voice ─────────
    // Whisper runs locally on Metal for voice transcription. Path is
    // overridable so the same binary works on Linux (CPU whisper.cpp)
    // or with a custom model size.
    const WHISPER_BIN = process.env.WHISPER_BIN ?? "/opt/homebrew/bin/whisper-cli"
    const WHISPER_MODEL = process.env.WHISPER_MODEL ?? path.join(Global.Path.home, "models", "whisper", "ggml-large-v3-turbo.bin")

    // Download a Telegram file by its file_id and return its raw bytes
    // plus a best-guess filename. Telegram's getFile returns a
    // file_path on the CDN which we can GET directly.
    async function downloadTelegramFile(fileId: string, fallbackName: string, fallbackMime: string): Promise<{ buffer: Uint8Array; filename: string; mime: string }> {
      const link = await bot.telegram.getFileLink(fileId)
      const res = await fetch(link.toString())
      if (!res.ok) throw new Error(`telegram download failed: ${res.status}`)
      const ab = await res.arrayBuffer()
      const mime = res.headers.get("content-type") ?? fallbackMime
      const filename = link.toString().split("/").pop() ?? fallbackName
      return { buffer: new Uint8Array(ab), filename, mime }
    }

    // Voice messages go through whisper.cpp to text. We don't ship the
    // audio to the model — speech-as-text is just a richer text prompt.
    async function transcribeAudio(buffer: Uint8Array, ext = "ogg"): Promise<string> {
      if (!(await Bun.file(WHISPER_BIN).exists())) {
        throw new Error(`whisper-cli not found at ${WHISPER_BIN} (set WHISPER_BIN env var to override)`)
      }
      if (!(await Bun.file(WHISPER_MODEL).exists())) {
        throw new Error(`whisper model not found at ${WHISPER_MODEL} (set WHISPER_MODEL env var to override)`)
      }
      // whisper.cpp's audio decoder (dr_wav) only handles PCM/WAV and
      // Ogg Vorbis — Telegram voice messages are Ogg Opus, which fails
      // silently with "failed to read audio data as wav". Pipe the raw
      // bytes through ffmpeg to canonical 16kHz mono PCM first, then
      // hand the wav to whisper. 16kHz/mono is whisper's native input
      // so we skip a redundant resample.
      const id = Date.now()
      const src = path.join(Global.Path.data, `voice-${id}.${ext}`)
      const wav = path.join(Global.Path.data, `voice-${id}.wav`)
      try {
        await Bun.write(src, buffer)
        const conv = Bun.spawn(
          [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", src,
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
            wav,
          ],
          { stderr: "pipe" },
        )
        const convErr = await new Response(conv.stderr).text()
        const convCode = await conv.exited
        if (convCode !== 0) {
          throw new Error(`ffmpeg conversion failed (${convCode}): ${convErr.trim()}`)
        }
        // -np = no progress, -otxt - = plain text to stdout.
        const proc = Bun.spawn(
          [WHISPER_BIN, "-m", WHISPER_MODEL, "-f", wav, "--no-timestamps", "-np", "-otxt", "-"],
          { stderr: "pipe" },
        )
        const [text, werr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        if (code !== 0) {
          throw new Error(`whisper-cli exited ${code}: ${werr.trim().split("\n").slice(-3).join(" | ")}`)
        }
        return text.trim()
      } finally {
        // Best-effort cleanup. Audio data may be sensitive (e.g.
        // dictation of private notes), so don't leave it lying around.
        await Bun.$`rm -f ${src} ${wav}`.quiet().nothrow()
      }
    }

    // Send a prompt with arbitrary parts (text + file attachments) to
    // the active session, creating one if needed. userPromptForEcho is
    // the text we'll use to match/dedupe the assistant's first chunk
    // so it doesn't get filtered as a user-prompt echo. For voice
    // prompts this is the transcribed text; for media without caption
    // we pass a synthetic label like "[image]" / "[voice]".
    //
    // Concurrency: if a previous prompt is still in flight on the same
    // session, abort it first and then send the new prompt. The session
    // history preserves the aborted turn's user message + partial
    // assistant reply, so the LLM sees two consecutive user turns
    // (old prompt → new prompt) and the new one becomes the active turn.
    // The aborted turn's in-progress assistant text is discarded by the
    // server.
    async function dispatchPrompt(
      cid: string,
      parts: Array<Record<string, any>>,
      userPromptForEcho: string,
    ) {
      let session = sessions.get(cid)
      if (!session) {
        const sid = await createSession(cid)
        if (!sid) return { error: "Failed to create session." as const }
        session = sessions.get(cid)
        if (!session) return { error: "Failed to create session." as const }
      }
      // Busy guard. If the previous prompt is still running, abort it
      // and wait for the server to acknowledge (session.status → idle)
      // before sending the new one. Without this, the second promptAsync
      // would either queue server-side (silently delaying) or race
      // against the first, fragmenting the assistant output.
      if (session.inflight) {
        console.error("[telegram] busy on session", session.sessionId, "— aborting previous")
        await reply(cid, "⏳ Bot is busy. Aborting the previous turn and sending your message…")
        try {
          await client.session.abort({ path: { id: session.sessionId } })
        } catch (e: any) {
          console.error("[telegram] abort error:", e?.message ?? e)
        }
        // Wait for the server's idle event. Poll the inflight flag with
        // a short backoff — the event-stream handler clears it on
        // session.status.type === "idle". Cap at 5s to avoid hanging
        // forever if the server never sends the event.
        const idleDeadline = Date.now() + 5000
        while (session.inflight && Date.now() < idleDeadline) {
          await new Promise((r) => setTimeout(r, 50))
        }
        if (session.inflight) {
          console.error("[telegram] abort timeout, forcing inflight clear")
          session.inflight = false
        }
      }
      session.userPrompt = userPromptForEcho
      session.inflight = true
      const result = await client.session.promptAsync({
        path: { id: session.sessionId },
        body: { parts: parts as any },
      })
      if (result.error) {
        // If the prompt itself failed, release the inflight flag so
        // the next message doesn't think the previous one is still
        // running. (The event stream will also clear it on the next
        // idle event, but that may be a while away.)
        session.inflight = false
        return { error: result.error.data?.message ?? "Failed" as const }
      }
      // Don't clear inflight here — the event stream clears it on
      // the matching `session.status` idle event. That way concurrent
      // messages see the correct busy state.
      return { ok: true as const }
    }

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
    type ModelEntry = { providerID: string; modelID: string; name: string }
    const KNOWN_PROVIDERS: ModelEntry[] = [
      { providerID: "omlx", modelID: "Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-MLX-oQ4-MTP", name: "oMLX · Qwen 3.6 35B" },
      { providerID: "anthropic", modelID: "MiniMax-M3", name: "MiniMax · MiniMax-M3 (1M ctx, via anthropic route)" },
      { providerID: "anthropic", modelID: "MiniMax-M2.7-highspeed", name: "MiniMax · MiniMax-M2.7 highspeed" },
      { providerID: "anthropic", modelID: "MiniMax-M2.7", name: "MiniMax · MiniMax-M2.7 (200K ctx)" },
    ]
    function getModelCatalog(): ModelEntry[] {
      return KNOWN_PROVIDERS
    }
    // Get the currently active default model from env or user config.
    // Used by /model to mark the current entry with a ✓ in the list.
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
    function getSessionTokens(sessionID: string): {
      total: number
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
      modelContextLimit: number | null
    } | null {
      let db: BunDB | null = null
      try {
        // Same DB path logic as @opencode-ai/core/database/path().
        // We replicate it inline to avoid pulling the whole Database
        // effect layer (and its boot-time side effects) into the bot.
        const dataDir = Global.Path.data
        const flagOverride = process.env.OPENCODE_DB
        let dbPath: string
        if (flagOverride) {
          dbPath = flagOverride === ":memory:" || flagOverride.startsWith("/")
            ? flagOverride
            : path.join(dataDir, flagOverride)
        } else {
          // The bot's channel is whatever InstallationChannel resolves to
          // at build time. On dev/checkout installs it ends up in
          // "opencode-dev.db"; on prod it's "opencode.db". We probe both
          // (dev first, since that's what the dev binary writes).
          const candidates = [
            path.join(dataDir, "opencode-dev.db"),
            path.join(dataDir, "opencode.db"),
          ]
          dbPath = candidates.find((p) => fs.existsSync(p)) ?? candidates[0]
        }
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
        // the percentage readout means something. We pull it from
        // either OPENCODE_DEFAULT_MODEL env or the config file.
        const cur = getCurrentModel()
        let modelContextLimit: number | null = null
        if (cur) {
          const limits: Record<string, number> = {
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
          modelContextLimit = limits[cur.modelID] ?? null
        }
        return {
          total: t.total ?? 0,
          input: t.input ?? 0,
          output: t.output ?? 0,
          reasoning: t.reasoning ?? 0,
          cacheRead: t.cache?.read ?? 0,
          cacheWrite: t.cache?.write ?? 0,
          modelContextLimit,
        }
      } catch (e) {
        console.error("[telegram] getSessionTokens failed:", e)
        return null
      } finally {
        try { db?.close() } catch {}
      }
    }
    function getCurrentModel(): { providerID: string; modelID: string } | null {
      const envModel = process.env.OPENCODE_DEFAULT_MODEL
      if (envModel && envModel.includes("/")) {
        const [p, m] = envModel.split("/", 2)
        return { providerID: p, modelID: m }
      }
      if (envModel) return { providerID: process.env.OPENCODE_DEFAULT_PROVIDER ?? "opencode", modelID: envModel }
      // Fall back to the opencode config file. Same probe order as
      // setDefaultModel() below — they must agree on the filename or
      // we write to one and read from the other and silently show
      // "(server default)".
      try {
        const configDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode")
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
    function setDefaultModel(
      providerID: string,
      modelID: string,
    ): { ok: true } | { ok: false; error: string } {
      try {
        const configDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode")
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
    // Resolve a user query against the catalog. Strict match on
    // "providerID/modelID", then prefix/suffix match on modelID,
    // then case-insensitive name contains. Returns undefined if no hit.
    function resolveModel(query: string, catalog: ModelEntry[]): ModelEntry | undefined {
      const q = query.trim()
      if (!q) return undefined
      if (q.includes("/")) {
        const [p, m] = q.split("/", 2)
        return catalog.find((c) => c.providerID === p && c.modelID === m)
      }
      // Exact modelID first
      const exact = catalog.find((c) => c.modelID === q)
      if (exact) return exact
      // Suffix match (e.g. "claude-sonnet-4-5" against "anthropic/claude-sonnet-4-5")
      const suffix = catalog.find((c) => c.modelID.endsWith(q) || c.modelID.includes(q))
      if (suffix) return suffix
      // Name contains
      const lower = q.toLowerCase()
      return catalog.find((c) => c.name.toLowerCase().includes(lower))
    }

    async function reply(cid: string, msg: string, extras?: any) {
      try {
        await bot.telegram.sendMessage(cid, msg, extras)
      } catch (e: any) {
        console.error("[telegram] reply error:", e?.message ?? e)
      }
    }

    // Send a question answer to the server via the v2 REST endpoint
    // (v1 SDK has no question API; v2 has client.question.reply but importing
    // both SDKs is overkill — just fetch directly.)
    async function answerQuestion(
      cid: string,
      questionID: string,
      answers: string[],
      sessionID: string,
    ) {
      try {
        const res = await fetch(`${server.url}/question/${questionID}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(process.cwd()) },
          body: JSON.stringify({ answers }),
        })
        console.error("[telegram] question reply status:", res.status)
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          await reply(cid, `❌ Question reply failed (${res.status}): ${text.slice(0, 200)}`)
        } else {
          pendingCustomQuestion.delete(cid)
          await reply(cid, "✅ Answer sent.")
        }
      } catch (e: any) {
        console.error("[telegram] question reply error:", e?.message ?? e)
        await reply(cid, `❌ Question reply error: ${e?.message ?? e}`)
      }
    }

    // ── Session map (with JSON persistence) ───────────────────────
    const SESSIONS_FILE = path.join(Global.Path.data, "telegram-sessions.json")
    type SessionState = {
      sessionId: string
      lastSent: string | null
      lastReasoning: string | null
      userPrompt: string | null
      // Telegram message id of the currently-streaming assistant text
      // message. Non-null between the first text chunk and the next
      // boundary (reasoning / tool / patch / idle). Lets us edit the
      // same message instead of spamming new ones for every token.
      streamMsgId: number | null
      // True while a session.promptAsync is in flight (between
      // dispatchPrompt start and the server's `session.status` idle
      // event). Gates the "busy" check in dispatchPrompt so a second
      // user message arriving mid-turn aborts the current task first.
      inflight: boolean
    }
    const sessions = new Map<string, SessionState>()
    // Track pending questions so callback buttons can resolve label from index
    const pendingQuestions = new Map<string, { sessionID: string; options: Array<{ label: string; description: string }> }>()
    // Track which question each chat is currently waiting for a custom answer on
    const pendingCustomQuestion = new Map<string, string>()

    // Load existing sessions on startup (only if file exists)
    const sessionsFileExists = yield* Effect.promise(() => Bun.file(SESSIONS_FILE).exists())
    if (sessionsFileExists) {
      try {
        const data = yield* Effect.promise(() => Bun.file(SESSIONS_FILE).json())
        for (const [cid, sess] of Object.entries(data as Record<string, any>)) {
          // Backward compat: older session files don't have streamMsgId.
          sessions.set(cid, { ...sess, streamMsgId: null, inflight: false })
        }
        console.error("[telegram] loaded", sessions.size, "persisted sessions")
      } catch (e: any) {
        console.error("[telegram] failed to load sessions:", e?.message ?? e)
      }
    } else {
      console.error("[telegram] no persisted sessions file, starting fresh")
    }

    // Persist sessions to disk (debounced)
    let persistTimer: ReturnType<typeof setTimeout> | null = null
    function persistSessions() {
      if (persistTimer) clearTimeout(persistTimer)
      persistTimer = setTimeout(async () => {
        try {
          await Bun.write(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2))
        } catch (e: any) {
          console.error("[telegram] failed to persist sessions:", e?.message ?? e)
        }
      }, 500)
    }

    // ── Message handler ────────────────────────────────────────────
    bot.on("message", async (ctx: any) => {
      const cid = String(ctx.chat.id)
      console.error("[telegram] message from", cid, "type:", ctx.chat.type, "subtype:", Object.keys(ctx.message ?? {}).filter((k) => !["date", "chat", "from", "message_id"].includes(k)).join(","))
      if (!allow(cid)) {
        console.error("[telegram] chat", cid, "not in allowlist, ignoring")
        return
      }
      // In group chats, only respond when @-mentioned or to commands
      if (ctx.chat.type !== "private") {
        const me = await ctx.telegram.getMe().catch(() => null)
        const username = me?.username ? `@${me.username}` : ""
        const isCommand = (ctx.message?.text ?? "").startsWith("/")
        if (!isCommand && username && !(ctx.message?.text ?? "").includes(username)) {
          console.error("[telegram] group message without mention, ignoring")
          return
        }
      }

      // ── Media: photo / voice / document ──────────────────────────
      // Each branch is self-contained: downloads the file, builds the
      // prompt parts, dispatches. Voice takes a transcription detour.
      const text = ctx.message?.text ?? ctx.message?.caption ?? ""

      if (ctx.message?.photo) {
        safe(async () => {
          const photos = ctx.message.photo as Array<{ file_id: string; width: number; height: number; file_size?: number }>
          // Telegram gives us a thumbnail ladder; pick the largest.
          const best = photos[photos.length - 1]
          const dl = await downloadTelegramFile(best.file_id, "photo.jpg", "image/jpeg")
          if (dl.buffer.byteLength > 6 * 1024 * 1024) {
            await reply(cid, "❌ Image too large (>6MB after base64 encoding). Send a smaller one.")
            return
          }
          const b64 = Buffer.from(dl.buffer).toString("base64")
          const dataUri = `data:image/jpeg;base64,${b64}`
          const caption = text || "[image]"
          const res = await dispatchPrompt(
            cid,
            [
              { type: "text", text: caption },
              { type: "file", mime: "image/jpeg", url: dataUri, filename: dl.filename },
            ],
            caption,
          )
          if (res?.error) await reply(cid, `Error: ${res.error}`)
        }, "photo handler")
        return
      }

      if (ctx.message?.voice || ctx.message?.audio) {
        const v = (ctx.message.voice ?? ctx.message.audio) as { file_id: string; mime_type?: string; duration: number; file_size?: number }
        safe(async () => {
          if (v.duration > 120) {
            await reply(cid, "❌ Voice message too long (>120s). Keep it under 2 minutes.")
            return
          }
          await reply(cid, "🎤 Transcribing…")
          const dl = await downloadTelegramFile(v.file_id, "voice.ogg", v.mime_type ?? "audio/ogg")
          const transcribed = await transcribeAudio(dl.buffer, "ogg")
          if (!transcribed) {
            await reply(cid, "❌ Could not transcribe audio (empty result).")
            return
          }
          await reply(cid, `📝 Heard: "${trunc(transcribed, 200)}"`)
          const finalText = text ? `${text}\n\n[voice] ${transcribed}` : transcribed
          const res = await dispatchPrompt(cid, [{ type: "text", text: finalText }], finalText)
          if (res?.error) await reply(cid, `Error: ${res.error}`)
        }, "voice handler")
        return
      }

      if (ctx.message?.document) {
        const d = ctx.message.document as { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
        safe(async () => {
          if (d.file_size && d.file_size > 20 * 1024 * 1024) {
            await reply(cid, "❌ Document too large (>20MB). Send a smaller one.")
            return
          }
          const dl = await downloadTelegramFile(d.file_id, d.file_name ?? "document", d.mime_type ?? "application/octet-stream")
          const b64 = Buffer.from(dl.buffer).toString("base64")
          const dataUri = `data:${dl.mime};base64,${b64}`
          const caption = text || `[file] ${dl.filename}`
          const res = await dispatchPrompt(
            cid,
            [
              { type: "text", text: caption },
              { type: "file", mime: dl.mime, url: dataUri, filename: dl.filename },
            ],
            caption,
          )
          if (res?.error) await reply(cid, `Error: ${res.error}`)
        }, "document handler")
        return
      }

      if (!text) return

      // ── Custom answer to a pending question ──────────────────────
      const pendingQID = pendingCustomQuestion.get(cid)
      if (pendingQID && !text.startsWith("/")) {
        const pending = pendingQuestions.get(pendingQID)
        if (pending) {
          await answerQuestion(cid, pendingQID, [text], pending.sessionID)
          pendingQuestions.delete(pendingQID)
        } else {
          pendingCustomQuestion.delete(cid)
        }
        return
      }

      // ── Commands ──────────────────────────────────────────────────
      if (text.startsWith("/")) {
        const parts = text.slice(1).split(/\s+/)
        const cmd = parts[0]?.toLowerCase()
        const args = parts.slice(1)

        if (cmd === "start") {
          await ctx.reply("👋 Welcome! Send me any request and I'll help you out.\n\nCommands:\n/new - create session\n/abort - stop task\n/status - show session\n/share - get share link\n/model - show or switch model\n/compact - summarize this session\n/fork - fork at last user message\n/retry - resend last prompt\n/sessions - list & switch sessions\n/whoami - show your chat ID\n/help - show this")
          return
        }
        if (cmd === "new") {
          const sid = await createSession(cid)
          if (!sid) { await ctx.reply("Failed to create session."); return }
          await ctx.reply(`✅ New session created: ${sid.slice(0, 8)}...`)
          return
        }
        if (cmd === "abort") {
          const session = sessions.get(cid)
          if (!session) { await ctx.reply("No active session."); return }
          await client.session.abort({ path: { id: session.sessionId } }).catch(() => {})
          session.lastSent = null
          session.lastReasoning = null
          session.userPrompt = null
          session.streamMsgId = null
          stopTyping(cid)
          await ctx.reply("✅ Task aborted.")
          return
        }
        if (cmd === "status") {
          safe(async () => {
            const session = sessions.get(cid)
            if (!session) { await ctx.reply("No active session. Send /new to create one."); return }
            // Pull server-side session state for the model + message count.
            // The shape of session.get() varies across opencode versions
            // (we hit "omlx/undefined" before), so read defensively.
            const sesRes = await client.session.get({ path: { id: session.sessionId } }).catch(() => null)
            const data = (sesRes?.data as any) ?? {}
            // The server's session.get() can return `model` as either a
            // { providerID, modelID } object or a flat string, depending
            // on version. Sometimes modelID is itself an object (e.g.
            // { name, id }) — keep recursing one level. Always extract
            // a `providerID/modelID` string, or null.
            let modelStr: string | null = null
            const extract = (v: any): string | null => {
              if (typeof v === "string") {
                return v.includes("/") ? v : null
              }
              if (!v || typeof v !== "object") return null
              // Common shapes:
              //   { providerID, modelID }          (canonical)
              //   { providerID, modelID: { id } }  (nested — modelID.id)
              //   { provider, model }              (alt names)
              //   { name, id }                     (model object without provider)
              const pid = v.providerID ?? v.provider
              let mid = v.modelID ?? v.model ?? v.id
              if (mid && typeof mid === "object") {
                mid = mid.id ?? mid.modelID ?? mid.name
              }
              if (typeof pid === "string" && typeof mid === "string" && mid && pid) {
                return `${pid}/${mid}`
              }
              // No provider at this level — maybe this object IS a
              // model descriptor (name + id) and the provider is on a
              // parent key. Caller handles that.
              if (typeof mid === "string" && mid) {
                return `?/${mid}`
              }
              return null
            }
            modelStr = extract(data.model) ?? extract(data.modelID)
            // If we got a `?/model` placeholder, try to recover the
            // provider from sibling fields.
            if (modelStr?.startsWith("?/")) {
              const pid = data.providerID ?? data.provider
              if (typeof pid === "string" && pid) {
                modelStr = `${pid}/${modelStr.slice(2)}`
              }
            }
            const current = modelStr && !modelStr.startsWith("?/")
              ? modelStr
              : (() => {
                  const c = getCurrentModel()
                  return c ? `${c.providerID}/${c.modelID}` : "(server default)"
                })()
            // Real token counts come from the latest assistant message
            // in the server's SQLite DB (see getSessionTokens for why).
            // The SDK's session.get() doesn't expose this — server's
            // session.get() returns the session struct but not a
            // rolled-up total.
            const tokens = getSessionTokens(session.sessionId)
            const modelCtxLimit = tokens?.modelContextLimit ?? null
            const total = tokens?.total ?? 0
            const input = tokens?.input ?? 0
            const output = tokens?.output ?? 0
            const cacheRead = tokens?.cacheRead ?? 0
            // Activity / state
            const lastSent = session.lastSent
              ? `${session.lastSent.length > 60 ? session.lastSent.slice(0, 57) + "..." : session.lastSent}`
              : "(none)"
            const lastReasoning = session.lastReasoning
              ? ` (last: ${session.lastReasoning.length > 40 ? session.lastReasoning.slice(0, 37) + "..." : session.lastReasoning})`
              : ""
            // Status state — derive from session.status when present, else
            // fall back to "idle" (most queries land here).
            const state = (session.status as any)?.type ?? data.status ?? "idle"
            const lines: string[] = [
              `📋 Session: \`${session.sessionId}\``,
              `🤖 Model: \`${current}\``,
              `🔄 State: ${state}${lastReasoning}`,
              `💬 Last: ${lastSent}`,
            ]
            // Message count from session data, not from the DB query
            const messages = (data.messages ?? data.messageCount) as number | undefined
            if (typeof messages === "number") {
              lines.push(`📨 Messages: ${messages}`)
            }
            if (tokens && total > 0) {
              // Build a compact breakdown. Skip the cache line if both
              // numbers are zero (no cache activity).
              const pct = modelCtxLimit
                ? ` · ${((total / modelCtxLimit) * 100).toFixed(1)}%`
                : ""
              const limitStr = modelCtxLimit
                ? ` / ${modelCtxLimit.toLocaleString()}`
                : ""
              const cacheLine = (cacheRead + tokens.cacheWrite) > 0
                ? ` (input ${input.toLocaleString()} + output ${output.toLocaleString()} · cache ${cacheRead.toLocaleString()}r/${tokens.cacheWrite.toLocaleString()}w)`
                : ` (input ${input.toLocaleString()} + output ${output.toLocaleString()})`
              lines.push(`📊 Context: ${total.toLocaleString()}${limitStr}${pct}${cacheLine}`)
            } else {
              lines.push(`📊 Context: (no assistant messages yet — send a prompt first)`)
            }
            await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
          }, "status handler")
          return
        }
        if (cmd === "share") {
          const session = sessions.get(cid)
          if (!session) { await ctx.reply("No active session."); return }
          const res = await client.session.share({ path: { id: session.sessionId } }).catch(() => null)
          const url = res?.data?.share?.url ?? `Session ${session.sessionId}`
          await ctx.reply(`🔗 ${url}`)
          return
        }
        if (cmd === "help") {
          await ctx.reply("Commands:\n/new - create session\n/abort - stop task\n/status - show session\n/share - get share link\n/model [query] - show or switch model\n/compact - summarize this session\n/fork - fork at last user message\n/retry - resend last prompt\n/sessions - list & switch sessions\n/whoami - show your chat ID\n/help - show this\n\nOr just send any request!")
          return
        }
        if (cmd === "whoami") {
          await ctx.reply(`Your chat ID: \`${cid}\``, { parse_mode: "Markdown" })
          return
        }
        if (cmd === "model") {
          safe(async () => {
            const s = sessions.get(cid)
            if (!s) { await reply(cid, "No active session. Send /new to create one."); return }
            const catalog = getModelCatalog()
            if (catalog.length === 0) {
              await reply(cid, "❌ Model catalog is empty.")
              return
            }
            const cur = getCurrentModel()
            const current = cur ? `${cur.providerID}/${cur.modelID}` : "(server default)"
            // Two modes:
            //   /model              → show current + inline keyboard picker
            //   /model <query>      → resolve and switch directly
            if (args.length === 0) {
              // Telegram callback_data is limited to 64 bytes, so we
              // reference models by index into the catalog (the catalog
              // is small + curated, so index collisions aren't a concern).
              const buttons = catalog.map((m, i) => [
                Markup.button.callback(
                  `${cur && cur.providerID === m.providerID && cur.modelID === m.modelID ? "✓ " : "  "}${m.name}  ·  ${m.providerID}/${m.modelID}`,
                  `model:${i}`,
                ),
              ])
              await ctx.reply(
                `🤖 Model\n  Current: \`${current}\`\n\nTap a model to set as default (server restart required to take effect on existing sessions):`,
                {
                  parse_mode: "Markdown",
                  ...Markup.inlineKeyboard(buttons),
                },
              )
              return
            }
            // Direct switch
            const target = resolveModel(args.join(" "), catalog)
            if (!target) {
              await reply(cid, `❌ Model not found: "${args.join(" ")}"\nTry /model for the list.`)
              return
            }
            const set = setDefaultModel(target.providerID, target.modelID)
            if (!set.ok) {
              await reply(cid, `❌ Could not persist default: ${set.error}`)
              return
            }
            await reply(cid, `✅ Default model set to \`${target.providerID}/${target.modelID}\`.\nNew sessions will use it. (Existing sessions are unchanged; restart the server to propagate to all clients.)`)
          }, "model handler")
          return
        }
        if (cmd === "compact") {
          safe(async () => {
            const s = sessions.get(cid)
            if (!s) { await reply(cid, "No active session. Send /new to create one."); return }
            const msgs = await client.session.messages({ path: { id: s.sessionId } }).catch(() => null)
            const list = (msgs?.data as any[]) ?? []
            const lastUser = [...list].reverse().find((m) => m.info?.role === "user")
            if (!lastUser) {
              await reply(cid, "❌ Nothing to compact — no user messages yet.")
              return
            }
            // Need a model to summarize with. Use the session's current model
            // if known, else the catalog's first.
            const sesRes = await client.session.get({ path: { id: s.sessionId } }).catch(() => null)
            const cur = (sesRes?.data as any)?.model
            let providerID = cur?.providerID
            let modelID = cur?.modelID
            if (!providerID || !modelID) {
              const catalog = getModelCatalog()
              if (catalog.length === 0) {
                await reply(cid, "❌ No model available to summarize with.")
                return
              }
              providerID = catalog[0].providerID
              modelID = catalog[0].modelID
            }
            await reply(cid, "📝 Compacting…")
            const res = await client.session.summarize({
              path: { id: s.sessionId },
              body: { providerID, modelID },
            }).catch((e: any) => ({ error: e }))
            if ((res as any)?.error) {
              await reply(cid, `❌ Compact failed: ${(res as any).error?.data?.message ?? (res as any).error?.message ?? "unknown"}`)
              return
            }
            await reply(cid, "✅ Compacted.")
          }, "compact handler")
          return
        }
        if (cmd === "fork") {
          safe(async () => {
            const s = sessions.get(cid)
            if (!s) { await reply(cid, "No active session. Send /new to create one."); return }
            const msgs = await client.session.messages({ path: { id: s.sessionId } }).catch(() => null)
            const list = (msgs?.data as any[]) ?? []
            const lastUser = [...list].reverse().find((m) => m.info?.role === "user")
            if (!lastUser) {
              await reply(cid, "❌ Nothing to fork — no user messages yet.")
              return
            }
            const res = await client.session.fork({
              path: { id: s.sessionId },
              body: { messageID: lastUser.info.id },
            }).catch((e: any) => ({ error: e }))
            const newId = (res as any)?.data?.id
            if (!newId) {
              await reply(cid, `❌ Fork failed: ${(res as any)?.error?.data?.message ?? (res as any)?.error?.message ?? "unknown"}`)
              return
            }
            // Switch active session to the fork
            sessions.set(cid, { sessionId: newId, lastSent: null, lastReasoning: null, userPrompt: null, streamMsgId: null, inflight: false })
            await reply(cid, `🍴 Forked!\nOld: \`${s.sessionId.slice(0, 8)}…\`\nNew: \`${newId.slice(0, 8)}…\``)
          }, "fork handler")
          return
        }
        if (cmd === "retry") {
          safe(async () => {
            const s = sessions.get(cid)
            if (!s) { await reply(cid, "No active session. Send /new to create one."); return }
            const msgs = await client.session.messages({ path: { id: s.sessionId } }).catch(() => null)
            const list = (msgs?.data as any[]) ?? []
            const lastUser = [...list].reverse().find((m) => m.info?.role === "user")
            if (!lastUser) {
              await reply(cid, "❌ Nothing to retry — no user messages yet.")
              return
            }
            // Reconstruct the text from text parts. Skip synthetic/internal parts.
            const text = (lastUser.parts ?? [])
              .filter((p: any) => p.type === "text" && !p.synthetic)
              .map((p: any) => p.text)
              .join("\n")
              .trim()
            if (!text) {
              await reply(cid, "❌ Last message has no text (e.g. media-only). Send a fresh prompt.")
              return
            }
            // Abort current turn if any, then redispatch
            await client.session.abort({ path: { id: s.sessionId } }).catch(() => {})
            s.lastSent = null
            s.lastReasoning = null
            s.userPrompt = null
            s.streamMsgId = null
            stopTyping(cid)
            const res = await dispatchPrompt(cid, [{ type: "text", text }], text)
            if (res?.error) await reply(cid, `Error: ${res.error}`)
          }, "retry handler")
          return
        }
        if (cmd === "sessions") {
          safe(async () => {
            const list = (await client.session.list().catch(() => null))?.data
            if (!Array.isArray(list) || list.length === 0) {
              await reply(cid, "No sessions yet.")
              return
            }
            const s = sessions.get(cid)
            const currentId = s?.sessionId
            // Sort by time.updated desc
            const sorted = [...list].sort((a: any, b: any) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
            const top = sorted.slice(0, 10)
            const lines = top.map((sess: any) => {
              const id = sess.id
              const short = id.slice(0, 8)
              const title = sess.title || "(untitled)"
              const sel = id === currentId ? " ←" : ""
              return `  ${short}…  ${trunc(title, 40)}${sel}`
            })
            // Build inline button rows. Limit to top 8 to keep the keyboard sane.
            const rows = top.slice(0, 8).map((sess: any) => [
              Markup.button.callback(
                `${sess.id === currentId ? "✅ " : ""}${sess.id.slice(0, 8)}… ${trunc(sess.title || "(untitled)", 24)}`,
                `sess:switch:${sess.id}`,
              ),
            ])
            const btns = Markup.inlineKeyboard(rows)
            await reply(cid, `📂 Sessions (${list.length}, showing top ${top.length}):\n${lines.join("\n")}\n\nTap to switch.`, btns)
          }, "sessions handler")
          return
        }
        // Unknown command — fall through to prompt
        return
      }

      // ── Regular prompt ──────────────────────────────────────────────
      safe(async () => {
        const res = await dispatchPrompt(cid, [{ type: "text", text }], text)
        if (res?.error) await reply(cid, `Error: ${res.error}`)
      }, "message handler")
    })

    // ── Callback query handler ────────────────────────────────────
    bot.on("callback_query", async (ctx: any) => {
      console.error("[telegram] DEBUG: callback_query event fired, data:", ctx.callbackQuery?.data)
      // Telegraf 4.x: answer via ctx.telegram.answerCallbackQuery
      if (ctx.telegram?.answerCallbackQuery) {
        await ctx.telegram.answerCallbackQuery(ctx.callbackQuery?.id).catch(() => {})
      } else if (typeof ctx.answerCallbackQuery === "function") {
        await ctx.answerCallbackQuery().catch(() => {})
      } else {
        console.error("[telegram] answerCallbackQuery not found, ctx keys:", Object.keys(ctx))
      }
      const data = ctx.callbackQuery?.data
      if (!data) return
      const msg = ctx.callbackQuery.message
      if (!msg) return
      const cid = String(msg.chat.id)
      if (!allow(cid)) {
        console.error("[telegram] callback from non-allowlisted chat", cid, ", ignoring")
        return
      }
      const session = sessions.get(cid)

      // ── Model picker (/model inline buttons) ─────────────────────
      // Format: model:<catalogIndex>  (index into KNOWN_PROVIDERS, see
      // comment on the button construction — full IDs overflow the 64
      // byte callback_data limit).
      if (data.startsWith("model:")) {
        const idx = Number.parseInt(data.slice("model:".length), 10)
        if (!Number.isFinite(idx) || idx < 0) return
        const catalog = getModelCatalog()
        const hit = catalog[idx]
        if (!hit) {
          await ctx.reply(`❌ Unknown model index: ${idx}`).catch(() => {})
          return
        }
        const { providerID, modelID } = hit
        const set = setDefaultModel(providerID, modelID)
        if (!set.ok) {
          await ctx.reply(`❌ Could not persist: ${set.error}`).catch(() => {})
          return
        }
        // Edit the original /model message to reflect the new selection
        const updated = `🤖 Model\n  Current: \`${providerID}/${modelID}\`\n\nTap a model to set as default (server restart required to take effect on existing sessions):`
        try {
          await ctx.editMessageText(updated, { parse_mode: "Markdown" })
        } catch {
          await ctx.reply(updated, { parse_mode: "Markdown" }).catch(() => {})
        }
        return
      }

      // ── Question answer ───────────────────────────────────────────
      if (data.startsWith("ques:")) {
        const parts = data.split(":")
        // Format: ques:<questionID>:<optionIndex | "custom">
        if (parts.length !== 3) return
        const questionID = parts[1]
        const answer = parts[2]
        if (answer === "custom") {
          // Set pending state — next text message will be the answer
          pendingCustomQuestion.set(cid, questionID)
          await reply(cid, "✏️ Please type your answer:")
          return
        }
        // Option button — look up the label from stored question
        const pending = pendingQuestions.get(questionID)
        if (!pending) {
          await reply(cid, "❌ Question expired, please resend your prompt.")
          return
        }
        const optionIndex = parseInt(answer, 10)
        if (isNaN(optionIndex) || optionIndex < 0 || optionIndex >= pending.options.length) {
          await reply(cid, "❌ Invalid option.")
          return
        }
        const label = pending.options[optionIndex].label
        await answerQuestion(cid, questionID, [label], pending.sessionID)
        pendingQuestions.delete(questionID)
        return
      }

      // ── Session switch from /sessions list ───────────────────────
      if (data.startsWith("sess:")) {
        const parts = data.split(":")
        if (parts.length !== 3 || parts[1] !== "switch") return
        const newId = parts[2]
        safe(async () => {
          const ver = await client.session.get({ path: { id: newId } }).catch(() => null)
          if (!ver || (ver as any).error) {
            await reply(cid, `❌ Session not found: ${newId.slice(0, 8)}…`)
            return
          }
          sessions.set(cid, { sessionId: newId, lastSent: null, lastReasoning: null, userPrompt: null, streamMsgId: null, inflight: false })
          stopTyping(cid)
          const title = (ver as any).data?.title ?? "(untitled)"
          await reply(cid, `✅ Switched to \`${newId.slice(0, 8)}…\` — ${trunc(title, 40)}`)
        }, "sess switch handler")
        return
      }

      if (!data.startsWith("perm:")) return
      const parts = data.split(":")
      if (parts.length !== 3) return
      const permissionID = parts[1]
      const action = parts[2] // "allow" | "deny" | "always"
      const response: "once" | "always" | "reject" = action === "deny" ? "reject" : action === "always" ? "always" : "once"
      if (!session) return
      safe(async () => {
        const res = await client.postSessionIdPermissionsPermissionId({
          path: { id: session.sessionId, permissionID },
          body: { response },
        })
        console.error("[telegram] permission response:", JSON.stringify(res))
        if (res.error) {
          const err = res.error as { _tag?: string; message?: string }
          // PermissionNotFoundError means user pressed a button twice or the request
          // already resolved — not a real error, just ignore silently.
          if (err._tag === "PermissionNotFoundError") {
            console.error("[telegram] permission already resolved, ignoring duplicate click")
            return
          }
          const msg = err.message ?? "Unknown error"
          await reply(cid, `❌ Permission error: ${msg}`)
        } else {
          const label = action === "deny" ? "denied" : action === "always" ? "always allowed" : "allowed"
          await reply(cid, `✅ Permission ${label}.`)
        }
      }, "callback_query handler")
    })

    // ── Event stream ──────────────────────────────────────────────
    console.error("[telegram] starting event stream IIFE...")
    ;(async () => {
      while (true) {
        try {
          console.error("[telegram] before event.subscribe()")
          const events = await client.event.subscribe()
          console.error("[telegram] event stream connected, waiting...")
          for await (const ev of events.stream) {
            try {
              console.error("[telegram] event:", ev.type)
              if (ev.type === "session.status") {
                const props = ev.properties as { sessionID: string; status: { type: string } }
                const cid = chatOf(props.sessionID)
                if (cid) {
                  const s = sessions.get(cid)
                  if (s) {
                    if (props.status?.type === "idle") {
                      // Close any in-flight stream so the next turn starts
                      // a fresh message. Also clear the inflight flag so
                      // dispatchPrompt knows it's safe to send a new
                      // prompt (and won't try to abort a "busy" session).
                      s.lastSent = null
                      s.lastReasoning = null
                      s.userPrompt = null
                      s.streamMsgId = null
                      s.inflight = false
                      stopTyping(cid)
                    } else {
                      // busy / retry — show "typing" indicator
                      startTyping(cid)
                    }
                  }
                }
                continue
              }

              // Session error — notify the user. Without this the bot goes
              // silent when the model or a tool fails, and the user has no
              // way to tell that anything went wrong.
              if (ev.type === "session.error") {
                const err = ev.properties as {
                  sessionID?: string
                  error?: { name?: string; message?: string; data?: { message?: string } }
                }
                console.error("[telegram] session.error:", JSON.stringify(err))
                const sid = err.sessionID
                if (!sid) continue
                const cid = chatOf(sid)
                if (!cid) continue
                const s = sessions.get(cid)
                if (s) {
                  s.lastSent = null
                  s.lastReasoning = null
                  s.userPrompt = null
                  s.streamMsgId = null
                }
                stopTyping(cid)
                const name = err.error?.name ?? "Error"
                const message = err.error?.data?.message ?? err.error?.message ?? "Unknown error"
                await reply(cid, `❌ ${name}: ${trunc(message, 3500)}`)
                continue
              }

              // Permission requested — show Allow/Deny buttons
              const evType = ev.type as string
              if (evType === "permission.asked") {
                const perm = ev.properties as {
                  id: string
                  sessionID: string
                  permission: string
                  patterns: string[]
                  metadata?: Record<string, unknown>
                }
                console.error("[telegram] permission.asked:", JSON.stringify(perm))
                const cid = chatOf(perm.sessionID)
                if (!cid) {
                  console.error("[telegram] permission session not found in sessions map, sessionIDs:", [...sessions.values()].map(s => s.sessionId))
                  continue
                }
                console.error("[telegram] sending permission buttons to cid:", cid)

                const pattern = perm.patterns.join(", ")
                const shortPattern = trunc(pattern, 200)
                const meta = (perm.metadata ?? {}) as { filepath?: string; parentDir?: string }
                const detail = meta.filepath ?? meta.parentDir ?? ""

                const msg = `🔒 Permission: ${perm.permission}${detail ? "\n" + detail : ""}${shortPattern ? "\n" + shortPattern : ""}`
                const btns = Markup.inlineKeyboard([
                  [Markup.button.callback("✅ Allow", `perm:${perm.id}:allow`)],
                  [Markup.button.callback("✅ Always", `perm:${perm.id}:always`)],
                  [Markup.button.callback("❌ Deny", `perm:${perm.id}:deny`)],
                ])
                await reply(cid, msg, btns)
                console.error("[telegram] permission buttons sent")
                continue
              }

              // Question asked — show options as buttons
              if (evType === "question.asked") {
                const q = ev.properties as {
                  id: string
                  sessionID: string
                  questions: Array<{
                    question: string
                    header: string
                    options: Array<{ label: string; description: string }>
                  }>
                }
                console.error("[telegram] question.asked:", JSON.stringify(q))
                const cid = chatOf(q.sessionID)
                if (!cid) {
                  console.error("[telegram] question session not found")
                  continue
                }
                for (const question of q.questions) {
                  // Store for label lookup on button press
                  pendingQuestions.set(q.id, { sessionID: q.sessionID, options: question.options })
                  const head = question.header ? `[${question.header}]\n` : ""
                  const text = `❓ ${head}${question.question}`
                  // Build one button row per option
                  const rows = question.options.map((opt, i) => [
                    Markup.button.callback(opt.label, `ques:${q.id}:${i}`),
                  ])
                  // Add a custom answer button if there are no options or tool allows it
                  if (question.options.length === 0) {
                    rows.push([Markup.button.callback("✏️ Custom answer", `ques:${q.id}:custom`)])
                  }
                  const btns = Markup.inlineKeyboard(rows)
                  await reply(cid, text, btns)
                  console.error("[telegram] question buttons sent for", question.header)
                }
                continue
              }

              // Message part updates
              if (ev.type !== "message.part.updated") continue
              const part = ev.properties.part
              const cid = chatOf(part.sessionID as string)
              if (!cid) continue
              const s = sessions.get(cid)
              if (!s) continue

              if (part.type === "text") {
                const p = part as { text: string }
                if (s.lastSent === p.text) continue
                if (s.userPrompt && p.text === s.userPrompt) {
                  s.userPrompt = null
                  continue
                }
                if (s.userPrompt && p.text.startsWith(s.userPrompt)) {
                  const rest = p.text.slice(s.userPrompt.length)
                  s.userPrompt = null
                  if (rest.trim()) {
                    s.lastSent = rest
                    await editOrSend(s, cid, rest)
                  }
                  continue
                }
                s.lastSent = p.text
                await editOrSend(s, cid, p.text)
              } else if (part.type === "reasoning") {
                // Reasoning breaks the text stream — close it first so the
                // next text chunk opens a fresh message.
                const p = part as { text: string }
                if (!p.text || !p.text.trim()) continue
                if (s.lastReasoning === p.text) continue
                s.lastReasoning = p.text
                closeStream(s)
                send(cid, `🧠 Thinking:\n\n${p.text}`)
              } else if (part.type === "tool") {
                // Each tool completion is its own notification, not part
                // of the streaming text message.
                const p = part as { tool: string; state: { status: string; title?: string } }
                if (p.state.status === "completed" && p.state.title) {
                  closeStream(s)
                  send(cid, `🔧 ${p.tool}: ${p.state.title}`)
                }
              } else if (part.type === "patch") {
                // Patch part summarizes file-level changes for the whole
                // assistant turn. The full diff is too large for Telegram
                // (4096 char limit) and would duplicate the tool messages
                // emitted per edit, so just show a per-file +/- count.
                const p = part as unknown as {
                  hash: string
                  files: Array<{ path: string; additions?: number; deletions?: number }>
                }
                if (!p.files?.length) continue
                closeStream(s)
                const lines = p.files.map((f) => {
                  const add = f.additions ?? 0
                  const del = f.deletions ?? 0
                  return `  ${f.path}  +${add} -${del}`
                })
                send(cid, `📝 ${p.files.length} file${p.files.length === 1 ? "" : "s"} changed:\n${lines.join("\n")}`)
              }
            } catch (evErr: any) {
              console.error("[telegram] event loop inner error:", evErr?.message ?? evErr)
            }
          }
        } catch (streamErr: any) {
          console.error("[telegram] event stream disconnected, reconnecting in 5s:", streamErr?.message ?? streamErr)
          await new Promise(r => setTimeout(r, 5000))
        }
      }
    })()
    console.error("[telegram] event stream started")

    // ── Register bot commands so Telegram shows the command menu ──────────
    console.error("[telegram] setting bot commands...")
    bot.telegram.setMyCommands([
      { command: "start", description: "Welcome message" },
      { command: "new", description: "Create a new session" },
      { command: "abort", description: "Stop current task" },
      { command: "status", description: "Show current session" },
      { command: "share", description: "Get share link" },
      { command: "model", description: "Show or switch model" },
      { command: "compact", description: "Summarize this session" },
      { command: "fork", description: "Fork at last user message" },
      { command: "retry", description: "Resend last prompt" },
      { command: "sessions", description: "List & switch sessions" },
      { command: "whoami", description: "Show your chat ID" },
      { command: "help", description: "Show all commands" },
    ]).then(() => console.error("[telegram] setMyCommands done")).catch((e: any) => console.error("[telegram] setMyCommands error:", e?.message ?? e))

    // ── Launch ─────────────────────────────────────────────────────
    console.error("[telegram] launching bot...")
    bot.launch().then(() => {
      console.error("[telegram] bot.launch() unexpectedly resolved")
    }).catch((err: any) => {
      console.error("[telegram] bot.launch() error:", err?.message ?? err)
    })

    // Clean up typing timers on shutdown so node doesn't keep the
    // event loop alive with stray intervals if bot.stop() races.
    const cleanupTyping = () => {
      for (const cid of [...typingTimers.keys()]) stopTyping(cid)
    }
    process.once("SIGINT", () => {
      cleanupTyping()
      bot.stop("SIGINT")
    })
    process.once("SIGTERM", () => {
      cleanupTyping()
      bot.stop("SIGTERM")
    })
    console.error("[telegram] calling getMe...")
    bot.telegram.getMe().then((me: any) => {
      console.error("[telegram] getMe SUCCESS:", me.username)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Telegram:     ", UI.Style.TEXT_NORMAL, `@${me.username}`)
    }).catch((e: any) => {
      console.error("[telegram] getMe error:", e?.message ?? e)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Telegram:     ", UI.Style.TEXT_NORMAL, "(unverified)")
    })

    if (allowedUsers.length > 0) {
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Allowed:      ", UI.Style.TEXT_NORMAL, allowedUsers.join(", "))
    }
    UI.empty()

    console.error("[telegram] entering Effect.never...")
    // Keep process alive — bot polling runs in background
    yield* Effect.never
  }),
})
