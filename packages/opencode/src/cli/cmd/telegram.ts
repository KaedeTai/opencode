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
        sessions.set(chatId, { sessionId, lastSent: null, lastReasoning: null, userPrompt: null, streamMsgId: null })
        persistSessions()
        return sessionId
      } catch (e: any) {
        console.error("[telegram] createSession error:", e?.message ?? e)
        return null
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
      const tmp = path.join(Global.Path.data, `voice-${Date.now()}.${ext}`)
      try {
        await Bun.write(tmp, buffer)
        // -np = no progress, -otxt - = plain text to stdout. whisper-cli
        // writes some ggml init spam to stderr but transcription goes to
        // stdout, so 2>/dev/null gives us a clean string.
        const proc = Bun.spawn(
          [WHISPER_BIN, "-m", WHISPER_MODEL, "-f", tmp, "--no-timestamps", "-np", "-otxt", "-"],
          { stderr: "ignore" },
        )
        const text = (await new Response(proc.stdout).text()).trim()
        const code = await proc.exited
        if (code !== 0) throw new Error(`whisper-cli exited ${code}`)
        return text
      } finally {
        // Best-effort cleanup of the temp file. Audio data may be
        // sensitive (e.g. dictation of private notes), so don't leave
        // it lying around.
        await Bun.$`rm -f ${tmp}`.quiet().nothrow()
      }
    }

    // Send a prompt with arbitrary parts (text + file attachments) to
    // the active session, creating one if needed. userPromptForEcho is
    // the text we'll use to match/dedupe the assistant's first chunk
    // so it doesn't get filtered as a user-prompt echo. For voice
    // prompts this is the transcribed text; for media without caption
    // we pass a synthetic label like "[image]" / "[voice]".
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
      session.userPrompt = userPromptForEcho
      const result = await client.session.promptAsync({
        path: { id: session.sessionId },
        body: { parts: parts as any },
      })
      if (result.error) {
        return { error: result.error.data?.message ?? "Failed" as const }
      }
      return { ok: true as const }
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
          sessions.set(cid, { ...sess, streamMsgId: null })
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
          session.lastSent = null
          session.lastReasoning = null
          session.userPrompt = null
          session.streamMsgId = null
          stopTyping(cid)
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
                      // a fresh message.
                      s.lastSent = null
                      s.lastReasoning = null
                      s.userPrompt = null
                      s.streamMsgId = null
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
