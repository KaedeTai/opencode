import { Telegraf } from "telegraf"
import { createOpencode } from "@opencode-ai/sdk"
import type { TextPart, ToolPart } from "@opencode-ai/sdk"

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!BOT_TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN environment variable")
  console.error("   Set it: export TELEGRAM_BOT_TOKEN='your-bot-token'")
  console.error("   Get one from: https://t.me/BotFather")
  process.exit(1)
}

// Allowed chat IDs (comma-separated). Empty = allow all.
const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
const isAllowed = (chatId: string) => ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(chatId)

console.log("🔧 Bot configuration:")
console.log("- Bot token present:", !!BOT_TOKEN)
if (ALLOWED_USERS.length > 0) console.log("- Allowed users:", ALLOWED_USERS.join(", "))

console.log("🚀 Starting opencode server...")
const opencode = await createOpencode({ port: 0 })
console.log("✅ Opencode server ready")

// Per-chat state
const sessions = new Map<string, {
  client: typeof opencode.client
  sessionId: string
  lastSent: string | null
}>()

const bot = new Telegraf(BOT_TOKEN)

// ── Commands ──────────────────────────────────────────────

bot.start((ctx) => {
  const chatId = String(ctx.chat.id)
  if (!isAllowed(chatId)) return ctx.reply("⛔ You are not allowed to use this bot.")

  return ctx.reply(
    [
      "👋 Welcome to opencode!",
      "",
      "Send a message to start a coding session.",
      "",
      "/new  — Create a new session",
      "/abort — Stop current task",
      "/share — Get session share link",
      "/help — Show this message",
    ].join("\n"),
  )
})

bot.help((ctx) => {
  return bot.handle.update("message", { message: { chat: ctx.chat, text: "/start" } }).catch(() => {})
})

bot.command("new", (ctx) => createNewSession(ctx))
bot.command("abort", (ctx) => handleAbort(ctx))

bot.command("status", (ctx) => {
  const chatId = String(ctx.chat.id)
  const session = sessions.get(chatId)
  if (!session) return ctx.reply("No active session. Send a message to start one.")
  return ctx.reply(`Session: ${session.sessionId}`)
})

bot.command("share", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const session = sessions.get(chatId)
  if (!session) return ctx.reply("No active session.")

  const res = await session.client.session.share({ path: { id: session.sessionId } })
  if (!res.error && res.data?.share?.url) {
    return ctx.reply(`Session link:\n${res.data.share.url}`)
  }
  return ctx.reply("Failed to get share link.")
})

// ── Global event stream ──────────────────────────────────

void (async () => {
  const events = await opencode.client.event.subscribe()
  for await (const event of events.stream) {
    if (event.type === "message.part.updated") {
      const part = event.properties.part

      if (part.type === "text") {
        const textPart = part as TextPart
        sendTextUpdate(textPart.sessionID, textPart.text)
      }

      if (part.type === "tool") {
        const toolPart = part as ToolPart
        if (toolPart.state.status === "completed" && toolPart.state.title) {
          sendToolUpdate(toolPart.sessionID, toolPart.tool, toolPart.state.title)
        }
      }
    }
  }
})()

// ── Handle text messages ─────────────────────────────────

bot.on("text", async (ctx) => {
  const chatId = String(ctx.chat.id)
  if (!isAllowed(chatId)) return ctx.reply("⛔ You are not allowed.")
  if (ctx.message.text.startsWith("/")) return
  if (ctx.message.caption) return // ignore captions

  await handlePrompt(ctx, chatId, ctx.message.text)
})

// ── Helpers ───────────────────────────────────────────────

async function handlePrompt(ctx: any, chatId: string, text: string) {
  let session = sessions.get(chatId)
  if (!session) {
    await createNewSession(ctx)
    session = sessions.get(chatId)
    if (!session) return
  }

  await sendToolUpdate(session.sessionId, "🧠", "Thinking...")

  ctx.telegram.sendChatAction(chatId, "typing")

  const result = await session.client.session.prompt({
    path: { id: session.sessionId },
    body: { parts: [{ type: "text", text }] },
  })

  if (result.error) {
    return ctx.reply(`Error: ${result.error.data?.message ?? "Failed to send prompt"}`)
  }
}

async function createNewSession(ctx: any) {
  const chatId = String(ctx.chat.id)
  const res = await opencode.client.session.create({ body: { title: `Telegram ${chatId}` } })
  if (res.error) return ctx.reply("Failed to create session.")

  const sessionId = res.data.id
  sessions.set(chatId, { client: opencode.client, sessionId, lastSent: null })

  await ctx.telegram.sendChatAction(chatId, "typing")
  await ctx.reply(`✅ Session created: ${sessionId}`)

  const share = await opencode.client.session.share({ path: { id: sessionId } })
  if (!share.error && share.data?.share?.url) {
    await ctx.reply(`Link: ${share.data.share.url}`)
  }
}

async function handleAbort(ctx: any) {
  const chatId = String(ctx.chat.id)
  const session = sessions.get(chatId)
  if (!session) return ctx.reply("No active session.")

  const res = await session.client.session.abort({ path: { id: session.sessionId } })
  if (res.error) return ctx.reply(`Abort failed: ${res.error.data?.message}`)
  return ctx.reply("Session aborted.")
}

function findChatId(sessionId: string) {
  for (const [chatId, s] of sessions.entries()) {
    if (s.sessionId === sessionId) return chatId
  }
  return null
}

async function sendTextUpdate(sessionId: string, text: string) {
  const chatId = findChatId(sessionId)
  if (!chatId) return

  const session = sessions.get(chatId)
  if (!session) return

  // Only send if the text has changed from last update
  if (session.lastSent === text) return
  session.lastSent = text

  const truncated = text.length > 4000 ? text.slice(0, 3997) + "..." : text
  await bot.telegram.sendMessage(chatId, truncated, { parse_mode: "HTML" }).catch((err) => {
    // Fallback without parse mode
    return bot.telegram.sendMessage(chatId, truncated).catch(() => {})
  })
}

async function sendToolUpdate(sessionId: string, tool: string, title: string) {
  const chatId = findChatId(sessionId)
  if (!chatId) return

  const msg = trunc(`🔧 ${tool}: ${title}`, 2000)
  await bot.telegram.sendMessage(chatId, msg).catch(() => {})
}

function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 3) + "..." : s
}

// ── Launch ────────────────────────────────────────────────

bot.launch().then((info) => {
  console.log(`⚡️ Telegram bot running! @${info.bot.username}`)
}).catch((err) => {
  console.error("❌ Failed to start bot:", err)
  process.exit(1)
})

process.once("SIGINT", () => bot.stop("SIGINT"))
process.once("SIGTERM", () => bot.stop("SIGTERM"))
