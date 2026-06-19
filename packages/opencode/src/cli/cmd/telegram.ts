import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import type { NetworkOptions } from "../network"
import path from "path"
import { Global } from "@opencode-ai/core/global"

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
    const bot = new Telegraf(token) as any
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
        sessions.set(chatId, { sessionId, lastSent: null, lastReasoning: null, userPrompt: null })
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

    async function reply(cid: string, msg: string, extras?: any) {
      try {
        await bot.telegram.sendMessage(cid, msg, extras)
      } catch (e: any) {
        console.error("[telegram] reply error:", e?.message ?? e)
      }
    }

    // ── Session map (with JSON persistence) ───────────────────────
    const SESSIONS_FILE = path.join(Global.Path.data, "telegram-sessions.json")
    const sessions = new Map<string, { sessionId: string; lastSent: string | null; lastReasoning: string | null; userPrompt: string | null }>()

    // Load existing sessions on startup (only if file exists)
    const sessionsFileExists = yield* Effect.promise(() => Bun.file(SESSIONS_FILE).exists())
    if (sessionsFileExists) {
      try {
        const data = yield* Effect.promise(() => Bun.file(SESSIONS_FILE).json())
        for (const [cid, sess] of Object.entries(data as Record<string, any>)) {
          sessions.set(cid, sess)
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
      const text = ctx.message?.text ?? ctx.message?.caption ?? ""
      const cid = String(ctx.chat.id)
      console.error("[telegram] message from", cid, "type:", ctx.chat.type, ":", JSON.stringify(text.slice(0, 80)))
      if (!text) return
      if (!allow(cid)) {
        console.error("[telegram] chat", cid, "not in allowlist, ignoring")
        return
      }
      // In group chats, only respond when @-mentioned or to commands
      if (ctx.chat.type !== "private") {
        const me = await ctx.telegram.getMe().catch(() => null)
        const username = me?.username ? `@${me.username}` : ""
        const isCommand = text.startsWith("/")
        if (!isCommand && username && !text.includes(username)) {
          console.error("[telegram] group message without mention, ignoring")
          return
        }
      }

      // ── Commands ──────────────────────────────────────────────────
      if (text.startsWith("/")) {
        const parts = text.slice(1).split(/\s+/)
        const cmd = parts[0]?.toLowerCase()
        const args = parts.slice(1)

        if (cmd === "start") {
          await ctx.reply("👋 Welcome! Send me any request and I'll help you out.\n\nCommands:\n/new - create session\n/abort - stop task\n/status - show session\n/share - get share link\n/help - show help")
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
          await ctx.reply("✅ Task aborted.")
          return
        }
        if (cmd === "status") {
          const session = sessions.get(cid)
          if (!session) { await ctx.reply("No active session. Send /new to create one."); return }
          await ctx.reply(`📋 Session: \`${session.sessionId}\``, { parse_mode: "Markdown" })
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
          await ctx.reply("Commands:\n/new - create session\n/abort - stop task\n/status - show session\n/share - get share link\n/whoami - show your chat ID\n/help - show this\n\nOr just send any request!")
          return
        }
        if (cmd === "whoami") {
          await ctx.reply(`Your chat ID: \`${cid}\``, { parse_mode: "Markdown" })
          return
        }
        // Unknown command — fall through to prompt
        return
      }

      // ── Regular prompt ──────────────────────────────────────────────
      safe(async () => {
        let session = sessions.get(cid)
        if (!session) {
          const sid = await createSession(cid)
          if (!sid) { await ctx.reply("Failed to create session."); return }
          session = sessions.get(cid)
          if (!session) return
        }
        session.userPrompt = ctx.message.text
        const result = await client.session.promptAsync({
          path: { id: session.sessionId },
          body: { parts: [{ type: "text", text: ctx.message.text }] },
        })
        if (result.error) {
          await ctx.reply(`Error: ${result.error.data?.message ?? "Failed"}`)
        }
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
      if (!data || !data.startsWith("perm:")) return
      const parts = data.split(":")
      if (parts.length !== 3) return
      const permissionID = parts[1]
      const action = parts[2] // "allow" | "deny" | "always"
      const response: "once" | "always" | "reject" = action === "deny" ? "reject" : action === "always" ? "always" : "once"
      const msg = ctx.callbackQuery.message
      if (!msg) return
      const cid = String(msg.chat.id)
      if (!allow(cid)) {
        console.error("[telegram] callback from non-allowlisted chat", cid, ", ignoring")
        return
      }
      const session = sessions.get(cid)
      if (!session) return
      safe(async () => {
        const res = await client.postSessionIdPermissionsPermissionId({
          path: { id: session.sessionId, permissionID },
          body: { response },
        })
        console.error("[telegram] permission response:", JSON.stringify(res))
        if (res.error) {
          await reply(cid, `❌ Permission error: ${res.error.data?.message ?? "Unknown"}`)
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
                if (props.status?.type === "idle") {
                  const cid = chatOf(props.sessionID)
                  if (cid) {
                    const s = sessions.get(cid)
                    if (s) { s.lastSent = null; s.lastReasoning = null; s.userPrompt = null }
                  }
                }
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
                    send(cid, rest)
                  }
                  continue
                }
                s.lastSent = p.text
                send(cid, p.text)
              } else if (part.type === "reasoning") {
                const p = part as { text: string }
                if (!p.text || !p.text.trim()) continue
                if (s.lastReasoning === p.text) continue
                s.lastReasoning = p.text
                send(cid, `🧠 Thinking:\n\n${p.text}`)
              } else if (part.type === "tool") {
                const p = part as { tool: string; state: { status: string; title?: string } }
                if (p.state.status === "completed" && p.state.title) {
                  send(cid, `🔧 ${p.tool}: ${p.state.title}`)
                }
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
