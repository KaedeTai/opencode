import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"

type TelegramArgs = {
  token?: string
  allowedUsers?: string
  hostname?: string
  port?: number
  mdns?: boolean
  mdnsDomain?: string
  cors?: boolean
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

    // ── Resolve bot token ──────────────────────────────────────────
    const token = args.token ?? process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
      return yield* fail(
        "Telegram bot token is required.\n" +
          "  Set TELEGRAM_BOT_TOKEN env var, or pass --token.\n" +
          "  Get one from: https://t.me/BotFather",
      )
    }

    const allowedUsers = (args.allowedUsers ?? process.env.TELEGRAM_ALLOWED_USERS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean)

    // ── Start server ──────────────────────────────────────────────
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Server:       ", UI.Style.TEXT_NORMAL, server.url.toString())

    // ── SDK client ────────────────────────────────────────────────
    const { createOpencodeClient } = yield* Effect.promise(() => import("@opencode-ai/sdk"))
    const client = createOpencodeClient({ baseUrl: server.url.toString() })

    // ── Telegraf bot ──────────────────────────────────────────────
    const { Telegraf } = yield* Effect.promise(() => import("telegraf"))
    const bot = new Telegraf(token)

    // ── Session map ───────────────────────────────────────────────
    const sessions = new Map<string, { sessionId: string; lastSent: string | null; lastReasoning: string | null }>()

    // ── Helpers ───────────────────────────────────────────────────
    async function createSession(chatId: string) {
      const res = await client.session.create({ body: { title: `Telegram ${chatId}` } })
      if (res.error) return null
      const sessionId = res.data.id
      sessions.set(chatId, { sessionId, lastSent: null, lastReasoning: null })
      return sessionId
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

    // ── Commands ──────────────────────────────────────────────────

    bot.start(async (ctx: any) => {
      const cid = String(ctx.chat.id)
      if (!allow(cid)) return ctx.reply("⛔ Not allowed.")
      return ctx.reply(
        "👋 Welcome to opencode!\n\nSend a message to start.\n\n/new — New session\n/abort — Stop\n/share — Link\n/help — Help",
      )
    })

    bot.help(async (ctx: any) => ctx.reply("/start · /new · /abort · /share · /help"))

    bot.command("new", async (ctx: any) => {
      const cid = String(ctx.chat.id)
      if (!allow(cid)) return ctx.reply("⛔ Not allowed.")
      const sid = await createSession(cid)
      if (!sid) return ctx.reply("Failed to create session.")
      const share = await client.session.share({ path: { id: sid } })
      const link = !share.error && share.data?.share?.url ? `\n${share.data.share.url}` : ""
      return ctx.reply(`✅ New session: ${sid}${link}`)
    })

    bot.command("abort", async (ctx: any) => {
      const cid = String(ctx.chat.id)
      const session = sessions.get(cid)
      if (!session) return ctx.reply("No active session.")
      const res = await client.session.abort({ path: { id: session.sessionId } })
      if (res.error) return ctx.reply(`Abort failed: ${res.error.data?.message}`)
      return ctx.reply("⏹️ Aborted.")
    })

    bot.command("status", async (ctx: any) => {
      const cid = String(ctx.chat.id)
      const session = sessions.get(cid)
      if (!session) return ctx.reply("No active session.")
      return ctx.reply(`Session: <code>${session.sessionId}</code>`, { parse_mode: "HTML" })
    })

    bot.command("share", async (ctx: any) => {
      const cid = String(ctx.chat.id)
      const session = sessions.get(cid)
      if (!session) return ctx.reply("No active session.")
      const res = await client.session.share({ path: { id: session.sessionId } })
      if (!res.error && res.data?.share?.url) return ctx.reply(res.data.share.url)
      return ctx.reply("Failed to get share link.")
    })

    // ── Text messages ─────────────────────────────────────────────

    bot.on("text", async (ctx: any) => {
      const cid = String(ctx.chat.id)
      if (!allow(cid)) return ctx.reply("⛔ Not allowed.")
      if (ctx.message.text.startsWith("/")) return
      if (ctx.message.caption) return

      let session = sessions.get(cid)
      if (!session) {
        const sid = await createSession(cid)
        if (!sid) return ctx.reply("Failed to create session.")
        session = sessions.get(cid)
        if (!session) return
      }

      try { await ctx.telegram.sendChatAction(cid, "typing") } catch {}

      const result = await client.session.prompt({
        path: { id: session.sessionId },
        body: { parts: [{ type: "text", text: ctx.message.text }] },
      })

      if (result.error) {
        await ctx.reply(`Error: ${result.error.data?.message ?? "Failed"}`)
      }
    })

    // ── Event stream ──────────────────────────────────────────────

    void (async () => {
      const events = await client.event.subscribe()
      for await (const ev of events.stream) {
        // session.status: reset track when session becomes idle
        if (ev.type === "session.status") {
          const status = ev.properties.status as string | undefined
          if (status === "idle" || status === "done") {
            const cid = chatOf(ev.properties.sessionID)
            if (cid) {
              const s = sessions.get(cid)
              if (s) {
                s.lastSent = null
                s.lastReasoning = null
              }
            }
          }
          continue
        }

        if (ev.type !== "message.part.updated") continue
        const part = ev.properties.part

        if (part.type === "text") {
          const p = part as { sessionID: string; text: string }
          const cid = chatOf(p.sessionID)
          if (!cid) continue
          const s = sessions.get(cid)
          if (!s) continue
          if (s.lastSent === p.text) continue
          s.lastSent = p.text
          const msg = trunc(p.text, 4000)
          try {
            await bot.telegram.sendMessage(cid, msg).catch(() => {})
          } catch {
            await bot.telegram.sendMessage(cid, msg).catch(() => {})
          }
        }

        if (part.type === "reasoning") {
          const p = part as { sessionID: string; text: string }
          const cid = chatOf(p.sessionID)
          if (!cid) continue
          const s = sessions.get(cid)
          if (!s) continue
          if (s.lastReasoning === p.text) continue
          s.lastReasoning = p.text
          const msg = trunc(`🧠 *Thinking*\n\n${p.text}`, Math.min(4000, p.text.length + 15))
          try {
            await bot.telegram.sendMessage(cid, msg, { parse_mode: "MarkdownV2" }).catch(() =>
              bot.telegram.sendMessage(cid, trunc(`🧠 Thinking:\n\n${p.text}`, 4000)))
          } catch {
            await bot.telegram.sendMessage(cid, trunc(p.text, 4000)).catch(() => {})
          }
        }

        if (part.type === "tool") {
          const p = part as { sessionID: string; tool: string; state: { status: string; title?: string } }
          if (p.state.status !== "completed" || !p.state.title) continue
          const cid = chatOf(p.sessionID)
          if (!cid) continue
          await bot.telegram.sendMessage(cid, trunc(`🔧 ${p.tool}: ${p.state.title}`, 2000)).catch(() => {})
        }
      }
    })()

    // ── Launch ────────────────────────────────────────────────────

    const info = yield* Effect.promise(() => bot.launch())
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Telegram:     ", UI.Style.TEXT_NORMAL, `@${info.bot.username}`)
    if (allowedUsers.length > 0) {
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Allowed:      ", UI.Style.TEXT_NORMAL, allowedUsers.join(", "))
    }
    UI.empty()

    yield* Effect.never
  }),
})
