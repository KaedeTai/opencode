import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import type { NetworkOptions } from "../network"

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
    const { Telegraf, Markup } = yield* Effect.promise(() => import("telegraf"))
    const bot = new Telegraf(token) as any

    // ── Global error handler — NEVER let unhandled errors kill the process ──
    bot.catch((err: any, ctx: any) => {
      console.error("[telegram] unhandled error:", err?.message ?? err, "ctx:", ctx?.updateType ?? "unknown")
    })

    // ── Session map ───────────────────────────────────────────────
    const sessions = new Map<string, { sessionId: string; lastSent: string | null; lastReasoning: string | null; userPrompt: string | null }>()

    // ── Helpers ───────────────────────────────────────────────────
    async function safe(fn: () => Promise<void>, label: string) {
      try {
        await fn()
      } catch (e: any) {
        console.error(`[telegram] ${label}:`, e?.message ?? e)
      }
    }

    async function createSession(chatId: string) {
      try {
        const res = await client.session.create({ body: { title: `Telegram ${chatId}` } })
        if (res.error) return null
        const sessionId = res.data.id
        sessions.set(chatId, { sessionId, lastSent: null, lastReasoning: null, userPrompt: null })
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

    // ── Commands ──────────────────────────────────────────────────

    void bot.start(async (ctx: any) => {
      await safe(async () => {
        const cid = String(ctx.chat.id)
        if (!allow(cid)) return ctx.reply("⛔ Not allowed.")
        return ctx.reply(
          "👋 Welcome to opencode!\n\nSend a message to start a coding session.\n\n" +
          "/new — New session\n/abort — Stop task\n/share — Link\n/help — Help",
        )
      }, "bot.start")
    })

    void bot.help(async (ctx: any) => {
      await safe(async () => {
        return ctx.reply(
          "/start — Welcome\n/new — New session\n/abort — Stop task\n/share — Session link\n/help — This message\n\n" +
          "Type any message to send a prompt to opencode.",
        )
      }, "bot.help")
    })

    void bot.command("new", async (ctx: any) => {
      await safe(async () => {
        const cid = String(ctx.chat.id)
        if (!allow(cid)) return ctx.reply("⛔ Not allowed.")
        const sid = await createSession(cid)
        if (!sid) return ctx.reply("Failed to create session.")
        const share = await client.session.share({ path: { id: sid } })
        const link = !share.error && share.data?.share?.url ? `\n${share.data.share.url}` : ""
        return ctx.reply(`✅ New session: ${sid}${link}`)
      }, "bot.command(new)")
    })

    void bot.command("abort", async (ctx: any) => {
      await safe(async () => {
        const cid = String(ctx.chat.id)
        const session = sessions.get(cid)
        if (!session) return ctx.reply("No active session.")
        const res = await client.session.abort({ path: { id: session.sessionId } })
        if (res.error) return ctx.reply(`Abort failed: ${res.error.data?.message}`)
        return ctx.reply("⏹️ Session aborted.")
      }, "bot.command(abort)")
    })

    void bot.command("status", async (ctx: any) => {
      await safe(async () => {
        const cid = String(ctx.chat.id)
        const session = sessions.get(cid)
        if (!session) return ctx.reply("No active session.")
        return ctx.reply(`Session: <code>${session.sessionId}</code>`, { parse_mode: "HTML" })
      }, "bot.command(status)")
    })

    void bot.command("share", async (ctx: any) => {
      await safe(async () => {
        const cid = String(ctx.chat.id)
        const session = sessions.get(cid)
        if (!session) return ctx.reply("No active session.")
        const res = await client.session.share({ path: { id: session.sessionId } })
        if (!res.error && res.data?.share?.url) return ctx.reply(res.data.share.url)
        return ctx.reply("Failed to get share link.")
      }, "bot.command(share)")
    })

    // ── Handle inline keyboard callbacks (permission buttons) ──────

    void bot.on("callback_query", async (ctx: any) => {
      await safe(async () => {
        await ctx.answerCallbackQuery()
        const data = ctx.update.callback_query.data
        if (!data.startsWith("perm:")) return

        // Parse: perm:<permissionID>:<action>
        const parts = data.split(":")
        if (parts.length !== 3) return
        const permissionID = parts[1]
        const action = parts[2] // "allow" or "deny"

        const cid = String(ctx.message.chat.id)
        const session = sessions.get(cid)
        if (!session) return

        // Use the permission endpoint to respond
        await client.postSessionIdPermissionsPermissionId({
          path: { id: session.sessionId, permissionID },
          body: { response: action },
        })

        await reply(cid, `✅ Permission ${action}ed.`)
      }, "bot.on(callback_query)")
    })

    // ── Text messages ─────────────────────────────────────────────

    void bot.on("message", async (ctx: any) => {
      await safe(async () => {
        if (!ctx.message?.text || ctx.message.text.startsWith("/") || ctx.message.caption) return
        const cid = String(ctx.chat.id)
        if (!allow(cid)) return ctx.reply("⛔ Not allowed.")

        let session = sessions.get(cid)
        if (!session) {
          const sid = await createSession(cid)
          if (!sid) return ctx.reply("Failed to create session.")
          session = sessions.get(cid)
          if (!session) return
        }

        // Track user prompt to avoid echoing it back
        session.userPrompt = ctx.message.text

        // Use promptAsync (non-blocking) — responses come via event stream
        const result = await client.session.promptAsync({
          path: { id: session.sessionId },
          body: { parts: [{ type: "text", text: ctx.message.text }] },
        })

        if (result.error) {
          await ctx.reply(`Error: ${result.error.data?.message ?? "Failed"}`)
        }
      }, "bot.on(message)")
    })

    // ── Event stream ──────────────────────────────────────────────

    ;(async () => {
      while (true) {
        try {
          const events = await client.event.subscribe()
          for await (const ev of events.stream) {
            try {
              // Session status — reset tracking state
              if (ev.type === "session.status") {
                const status = (ev.properties as any).status
                if (status === "idle" || status === "done") {
                  const cid = chatOf(ev.properties.sessionID)
                  if (cid) {
                    const s = sessions.get(cid)
                    if (s) { s.lastSent = null; s.lastReasoning = null; s.userPrompt = null }
                  }
                }
                continue
              }

              // Permission requested — show Allow/Deny buttons
              if (ev.type === "permission.updated") {
                const perm = ev.properties as { id: string; sessionID: string; title: string; type: string; pattern?: string | string[] }
                const cid = chatOf(perm.sessionID)
                if (!cid) continue

                const pattern = Array.isArray(perm.pattern) ? perm.pattern.join(", ") : (perm.pattern ?? "")
                const shortPattern = trunc(pattern, 200)

                const msg = `🔒 Permission: ${perm.type}\n${perm.title}${shortPattern ? "\n" + shortPattern : ""}`
                const btns = Markup.inlineKeyboard([
                  [Markup.button.callback("✅ Allow", `perm:${perm.id}:allow`)],
                  [Markup.button.callback("❌ Deny", `perm:${perm.id}:deny`)],
                ])
                await reply(cid, msg, btns)
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
                // Skip user's own prompt (first text part is often echoed by the model)
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

    // ── Register bot commands so Telegram shows the command menu ──────────
    yield* Effect.promise(() => bot.telegram.setMyCommands([
      { command: "start", description: "Welcome message" },
      { command: "new", description: "Create a new session" },
      { command: "abort", description: "Stop current task" },
      { command: "status", description: "Show current session" },
      { command: "share", description: "Get share link" },
      { command: "help", description: "Show all commands" },
    ]))

    // ── Launch ────────────────────────────────────────────────────

    try {
      yield* Effect.promise(() => bot.launch())
    } catch(_e: any) {
      console.error("[telegram] bot.launch() failed:", _e?.message ?? _e)
      // Don't return — let the process stay alive so we can see errors
    }
    try {
      const username = yield* Effect.promise(async () => (await bot.telegram.getMe()).username)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Telegram:     ", UI.Style.TEXT_NORMAL, `@${username}`)
      if (allowedUsers.length > 0) {
        UI.println(UI.Style.TEXT_INFO_BOLD + "  Allowed:      ", UI.Style.TEXT_NORMAL, allowedUsers.join(", "))
      }
      UI.empty()
    } catch (_e: any) {
      console.error("[telegram] getMe failed:", _e?.message ?? _e)
    }

    yield* Effect.never
  }),
})
