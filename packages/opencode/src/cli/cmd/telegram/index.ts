import { Effect } from "effect"
import type { Argv } from "yargs"
import { UI } from "../../ui"
import { effectCmd, fail } from "../../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../../network"
import type { NetworkOptions } from "../../network"
import { getModelCatalog, getModelContextLimit, getCurrentModel, setDefaultModel, resolveModel, getSessionTokens } from "./config"
import { trunc } from "./format"
import { log } from "./log"
import { transcribeAudio } from "./whisper"
import { getSessionsFile } from "./paths"
import type { OpencodeClient } from "@opencode-ai/sdk"

// The v2 SDK returns loosely-typed responses for several endpoints
// (session.get / .list / .messages / .fork / .summarize). The fields
// the bot actually reads don't always line up with the declared
// `Session` shape — different opencode versions emit different
// shapes, and the SDK is a step behind. Rather than cast to `any`,
// we declare a narrow view that captures only what the bot reads.
// `as unknown as SessionLike` makes the intent explicit and lets
// the type checker flag real regressions.
type SessionLike = {
  id?: string
  title?: string
  status?: string
  messages?: number
  messageCount?: number
  model?:
    | string
    | { providerID?: string; modelID?: string; id?: string; model?: unknown; provider?: string; name?: string }
    | null
  providerID?: string
  provider?: string
}

type SessionMessageListItem = {
  info?: { id?: string; role?: string }
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean }>
}

type SessionListItem = {
  id: string
  title?: string
  time?: { updated?: number }
}

type ErrorLike = { error?: { _tag?: string; data?: { message?: string }; message?: string } | null }

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
  builder: (yargs: Argv) =>
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
    const args = rawArgs as unknown as TelegramArgs

    // ── Resolve bot token ──────────────────────────────────────────
    const token = args.token ?? process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
      return yield* fail(
        "Telegram bot token is required.\n" +
          "  Set TELEGRAM_BOT_TOKEN env var, or pass --token.\n" +
          "  Get one from: https://t.me/BotFather",
      )
    }
    yield* Effect.logDebug("telegram token resolved")

    const allowedUsers = (args.allowedUsers ?? process.env.TELEGRAM_ALLOWED_USERS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean)
    yield* Effect.logDebug("telegram allowedUsers set", { count: allowedUsers.length })

    // ── Start server ──────────────────────────────────────────────
    const { Server } = yield* Effect.promise(() => import("../../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    yield* Effect.logInfo("telegram server started", { url: server.url.toString() })

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Server:       ", UI.Style.TEXT_NORMAL, server.url.toString())

    // ── SDK client ────────────────────────────────────────────────
    const { createOpencodeClient } = yield* Effect.promise(() => import("@opencode-ai/sdk"))
    const client = createOpencodeClient({ baseUrl: server.url.toString() })
    yield* Effect.logDebug("telegram SDK client created")

    // ── Telegraf bot ──────────────────────────────────────────────
    const { Telegraf, Markup } = yield* Effect.promise(() => import("telegraf"))
    // handlerTimeout default in Telegraf is 90s. Our command handlers
    // do fire-and-forget dispatch via `safe()`, so a single command
    // should resolve within milliseconds. A 90s window is dangerous:
    // if anything inside the handler awaits a slow network call
    // (Telegram API, opencode SDK), the whole long-poll cycle freezes
    // for 90s, the bot appears unresponsive, and the next user
    // message queues up behind the stuck one. 5s is plenty for our
    // handlers — anything slower than that almost certainly is the
    // Telegram API itself, which we don't want to block polling on.
    const bot = new Telegraf(token, { handlerTimeout: 5_000 })
    yield* Effect.logDebug("telegram bot created")

    // ── Global error handler ──────────────────────────────────────
    bot.catch((err: unknown, ctx: any) => {
      const e = err as { message?: string }
      log.error("unhandled error", { message: e?.message ?? String(err), updateType: ctx?.updateType })
    })

    // ── Helpers ───────────────────────────────────────────────────
    // Extract a useful message from a catch value. The Promise/catch
    // surface gives us `unknown`; narrow to Error if possible.
    const eMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

    function safe(fn: () => Promise<void>, label: string) {
      fn().catch((e) => log.error(label, { message: eMsg(e) }))
    }

    async function createSession(cid: string) {
      try {
        const res = await client.session.create({ body: { title: `Telegram ${cid}` } })
        if (res.error) return null
        const sessionId = res.data.id
        addSession(cid, { sessionId, lastSent: null, lastReasoning: null, userPrompt: null, streamMsgId: null, lastStreamEdit: null, inflight: false, inflightWait: null, inflightWaitTimer: null, lastRetryAttempt: null })
        return sessionId
      } catch (e) {
        log.error("createSession", { message: eMsg(e) })
        return null
      }
    }

    // Resolve the chat that owns a session. Backed by the reverse
    // index so it's O(1) — the inline version (iterating `chats`)
    // would scale linearly with the number of chats the bot has
    // ever seen.
    // (Implementation lives in the helpers block below; the binding
    // is hoisted by `function` so the call sites above resolve.)

    function allow(chatId: string): boolean {
      return allowedUsers.length === 0 || allowedUsers.includes(chatId)
    }

    async function send(cid: string, msg: string) {
      if (!msg || !msg.trim()) return
      try {
        await bot.telegram.sendMessage(cid, trunc(msg, 4000))
      } catch (e) {
        log.error("send", { message: eMsg(e) })
      }
    }

    // Streaming editor: edit the in-flight assistant message in
    // place, or send a new one and remember its id. Skips the round-trip
    // when the new text is identical to what we last wrote (Telegram
    // also rejects no-op edits).
    async function editOrSend(s: SessionState, cid: string, text: string) {
      if (!text || !text.trim()) return
      // Models occasionally emit literal "undefined" tokens when they
      // guess a field that wasn't in the tool result (e.g. "1 file
      // changed: undefined +0 -0"). Strip bare undefineds — they only
      // ever look like broken placeholders, never like intentional text.
      const cleaned = text.replace(/\bundefined\b/g, "")
      const body = trunc(cleaned, 4000)
      if (s.streamMsgId == null) {
        try {
          const m = await bot.telegram.sendMessage(cid, body)
          s.streamMsgId = m?.message_id ?? null
        } catch (e) {
          log.error("stream start", { message: eMsg(e) })
        }
        return
      }
      try {
        await bot.telegram.editMessageText(cid, s.streamMsgId, undefined, body)
      } catch (e) {
        const msg = eMsg(e)
        if (msg.includes("not modified")) return
        // Edit can fail if Telegram thinks the message is too old or the
        // text is identical; fall back to a fresh message.
        log.warn("stream edit failed, sending new", { message: msg })
        try {
          const m = await bot.telegram.sendMessage(cid, body)
          s.streamMsgId = m?.message_id ?? null
        } catch (e2) {
          log.error("stream fallback send", { message: eMsg(e2) })
        }
      }
    }

    // Rate-limited wrapper around editOrSend. Telegram caps edits at
    // ~20/min on the same message and ~30/min total; on a long reply
    // a token-by-token stream would blow past both. We do leading-edge
    // when the throttle window has elapsed, and trailing-edge otherwise
    // so the user still sees the final value once the model goes quiet.
    const STREAM_THROTTLE_MS = 1500
    type StreamPending = { timer: ReturnType<typeof setTimeout>; text: string; s: SessionState }
    const streamPending = new Map<string, StreamPending>()
    function scheduleStreamEdit(s: SessionState, cid: string, text: string) {
      if (!text || !text.trim()) return
      if (s.streamMsgId == null) {
        // No message yet — must sendMessage; throttle doesn't apply.
        void editOrSend(s, cid, text)
        return
      }
      const existing = streamPending.get(cid)
      if (existing) {
        // Coalesce: just overwrite the pending text. The trailing edit
        // will pick up the latest value when the window opens.
        existing.text = text
        return
      }
      const now = Date.now()
      const last = s.lastStreamEdit ?? 0
      if (now - last >= STREAM_THROTTLE_MS) {
        void editOrSend(s, cid, text)
        s.lastStreamEdit = now
        return
      }
      const delay = STREAM_THROTTLE_MS - (now - last)
      const timer = setTimeout(() => {
        const pending = streamPending.get(cid)
        if (!pending) return
        void editOrSend(pending.s, cid, pending.text)
        pending.s.lastStreamEdit = Date.now()
        streamPending.delete(cid)
      }, delay)
      streamPending.set(cid, { timer, text, s })
    }
    function clearPendingStreamEdit(cid: string) {
      const pending = streamPending.get(cid)
      if (!pending) return
      clearTimeout(pending.timer)
      streamPending.delete(cid)
    }

    // Close the stream — next text part starts a new message. We don't
    // delete the old one, just drop our handle. Also clear the
    // throttle bookkeeping and any pending trailing edit so the new
    // stream starts cleanly. Takes cid so it can drop the per-chat
    // pending edit (which would otherwise fire after a delay and
    // create a late "echo" of the just-closed stream).
    function closeStream(s: SessionState, cid: string) {
      s.streamMsgId = null
      s.lastStreamEdit = null
      clearPendingStreamEdit(cid)
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
          .catch((e) => log.error("sendChatAction", { message: eMsg(e) }))
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
      options: { targetSessionId?: string } = {},
    ) {
      // Resolve the target session. `targetSessionId` lets callers
      // route a prompt to a non-active session (e.g. the user typed
      // "[<id>] hi" or invoked `/to <id>`). Otherwise we use the
      // chat's active session, creating one on first use.
      let session = options.targetSessionId
        ? getSession(cid, options.targetSessionId)
        : getActiveSession(cid)
      // DEBUG-2026-06-21: log which session we resolved + server-side token count
      // before dispatching, to detect when bot picks a dead/oversized session
      log.info("dispatchPrompt.resolve", {
        cid,
        targetSessionId: options.targetSessionId ?? null,
        resolvedSessionId: session?.sessionId ?? null,
      })
      if (session) {
        // server-side session.get() to read tokens (mirrors /status output)
        client.session
          .get({ path: { id: session.sessionId } })
          .then((res) => {
            const data = res.data as { tokens?: { input?: number; cache?: { read?: number } } } | undefined
            log.info("dispatchPrompt.serverTokens", {
              sessionId: session!.sessionId,
              inputTokens: data?.tokens?.input ?? null,
              cacheReadTokens: data?.tokens?.cache?.read ?? null,
            })
          })
          .catch((e) => log.warn("dispatchPrompt.serverTokensFailed", { error: eMsg(e) }))
      }
      if (!session) {
        const sid = await createSession(cid)
        if (!sid) return { error: "Failed to create session." as const }
        session = options.targetSessionId
          ? getSession(cid, options.targetSessionId) ?? getActiveSession(cid)
          : getActiveSession(cid)
        if (!session) return { error: "Failed to create session." as const }
      }
      // Busy guard. If the previous prompt is still running on THIS
      // session, abort it and wait for the server to acknowledge
      // (session.status → idle) before sending the new one. Without
      // this, the second promptAsync would either queue server-side
      // (silently delaying) or race against the first, fragmenting
      // the assistant output. Other sessions in the same chat are
      // unaffected — the user can drive them in parallel.
      if (session.inflight) {
        log.warn("busy on session, aborting previous", { sessionId: session.sessionId })
        await reply(cid, "⏳ Bot is busy. Aborting the previous turn and sending your message…")
        try {
          await client.session.abort({ path: { id: session.sessionId } })
        } catch (e) {
          log.error("abort", { message: eMsg(e) })
        }
        // Event-driven idle wait: the session.status=idle handler in
        // the event stream resolves inflightWait. A 5s safety timer
        // force-resolves in case the event is lost — we don't want to
        // hang a user prompt forever.
        await new Promise<void>((resolve) => {
          session!.inflightWait = resolve
          session!.inflightWaitTimer = setTimeout(() => {
            if (!session!.inflightWait) return
            log.warn("idle wait timeout, forcing inflight clear", { sessionId: session!.sessionId })
            session!.inflight = false
            session!.inflightWait = null
            session!.inflightWaitTimer = null
            resolve()
          }, 5000)
        })
      }
      session.userPrompt = userPromptForEcho
      session.inflight = true
      const result = await client.session.promptAsync({
        path: { id: session.sessionId },
        // parts is `Array<Record<string, any>>` because the SDK's
        // Part union is several types we mix in one array (text
        // + file). The SDK accepts a wider type than the union
        // here, hence the double cast (Record<string, any> ->
        // unknown -> SDK union).
        body: { parts: parts as unknown as never[] },
      })
      if (result.error) {
        session.inflight = false
        // DEBUG-2026-06-21: server prune deleted this session while disk still
        // referenced it. Auto-recover: create a fresh session, swap active,
        // surface a hint to the user, then return ok so the new prompt continues.
        const errMsg = result.error.data?.message ?? ""
        if (errMsg.toLowerCase().includes("session not found") || errMsg.toLowerCase().includes("not found")) {
          log.warn("dispatchPrompt.sessionMissing", {
            oldSessionId: session.sessionId,
            errMsg,
          })
          // Promote next-most-recent surviving session, or create fresh.
          const replacement = pickFallbackSession(cid, session.sessionId)
          if (replacement) {
            setActiveSession(cid, replacement)
            await reply(
              cid,
              `♻️ Old session was cleaned up server-side. Switched to ${replacement.slice(0, 8)}… — re-send your prompt.`,
            )
            // Don't return ok — user must re-send because we lost their text
            return { error: "Session missing — switched to fallback" as const }
          }
          const fresh = await createSession(cid)
          if (fresh) {
            await reply(
              cid,
              `♻️ Old session was cleaned up server-side. Started a fresh session — re-send your prompt.`,
            )
            return { error: "Session missing — fresh session created" as const }
          }
        }
        return { error: errMsg || "Failed" as const }
      }
      // Don't clear inflight here — the event stream clears it on
      // the matching `session.status` idle event. That way concurrent
      // messages see the correct busy state.
      return { ok: true as const }
    }

    async function reply(cid: string, msg: string, extras?: Parameters<typeof bot.telegram.sendMessage>[2]) {
      try {
        await bot.telegram.sendMessage(cid, msg, extras)
      } catch (e) {
        log.error("reply", { message: eMsg(e) })
      }
    }

    // Send a question answer to the server via the v2 REST endpoint
    // (v1 SDK has no question API; v2 has client.question.reply but importing
    // both SDKs is overkill — just fetch directly.)
    //
    // Server schema: `Question.Answer = string[]` and `payload.answers` is
    // `Array<Question.Answer>` (i.e. string[][]). Each question in the
    // question.asked event gets one slot; each slot is an array of selected
    // option labels (multi-select supported). For a single-select click we
    // wrap the chosen label in a 1-element array.
    async function answerQuestion(
      cid: string,
      questionID: string,
      answers: string[][],
      sessionID: string,
    ) {
      try {
        const res = await fetch(`${server.url}/question/${questionID}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(process.cwd()) },
          body: JSON.stringify({ answers }),
        })
        log.debug("question reply status", { status: res.status })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          await reply(cid, `❌ Question reply failed (${res.status}): ${text.slice(0, 200)}`)
        } else {
          pendingCustomQuestion.delete(cid)
          await reply(cid, "✅ Answer sent.")
        }
      } catch (e) {
        log.error("question reply", { message: eMsg(e) })
        await reply(cid, `❌ Question reply error: ${eMsg(e)}`)
      }
    }

    // ── Session map (with JSON persistence) ───────────────────────
    const SESSIONS_FILE = getSessionsFile()
    type SessionState = {
      sessionId: string
      lastSent: string | null
      lastReasoning: string | null
      userPrompt: string | null
      // Last retry attempt we already notified the user about, so a
      // burst of status.type=retry events for the same attempt only
      // sends one Telegram message.
      lastRetryAttempt: number | null
      // Telegram message id of the currently-streaming assistant text
      // message. Non-null between the first text chunk and the next
      // boundary (reasoning / tool / patch / idle). Lets us edit the
      // same message instead of spamming new ones for every token.
      streamMsgId: number | null
      // Wall-clock time (ms) of the last editMessageText to the
      // streaming message. Used by the throttle in scheduleStreamEdit
      // to enforce a minimum gap between edits.
      lastStreamEdit: number | null
      // True while a session.promptAsync is in flight (between
      // dispatchPrompt start and the server's `session.status` idle
      // event). Gates the "busy" check in dispatchPrompt so a second
      // user message arriving mid-turn aborts the current task first.
      inflight: boolean
      // Resolver for any dispatchPrompt currently waiting for this
      // session to go idle. Set when a new prompt arrives mid-turn;
      // called by the event stream's session.status=idle handler.
      // Cleared after use. Lets us replace the old 50ms polling loop
      // with a real event-driven wait.
      inflightWait: (() => void) | null
      // Safety timer paired with inflightWait. If the server never
      // sends idle (e.g. lost event), force-resolve after 5s so the
      // next prompt isn't held forever.
      inflightWaitTimer: ReturnType<typeof setTimeout> | null
    }
    // Per-chat state. Each chat can have multiple sessions; the
    // active one receives new prompts by default. All in-flight
    // turns are tracked per-session, so one chat can have several
    // sessions running in parallel (multi-prompt scenarios).
    type ChatState = {
      // Session id of the currently active session, or null when the
      // chat has no sessions (transient — `/new` will populate it).
      activeSessionId: string | null
      // All sessions for this chat, keyed by session id. Holds the
      // active + archived ones together so handlers can iterate.
      sessions: Record<string, SessionState>
      // Session id ordering, most recent first. Drives /sessions
      // listings and pickers.
      order: string[]
    }
    const chats = new Map<string, ChatState>()
    // Reverse index for chatOf(sessionId). Without this, looking
    // up a chat from a session id would have to scan every chat
    // (slow as the bot runs longer).
    const sessionToChat = new Map<string, string>()

    // Track pending questions so callback buttons can resolve label from index.
    // One q.id can have N questions (server schema: payload.answers is string[][],
    // one slot per question). We store ALL options arrays here keyed by qid so
    // the button callback can resolve any question's option index, and accumulate
    // answers in pendingAnswers (one slot per question) until all are answered
    // before posting to the server.
    const pendingQuestions = new Map<
      string,
      {
        sessionID: string
        questions: Array<{ options: Array<{ label: string; description: string }> }>
      }
    >()
    // Accumulated answers per qid: pendingAnswers.get(qid)[questionIndex] = string[]
    const pendingAnswers = new Map<string, string[][]>()
    // Track which question each chat is currently waiting for a custom answer on
    // (qid + questionIndex, since the same chat could be mid-custom on one of
    // several questions).
    const pendingCustomQuestion = new Map<string, { questionID: string; questionIndex: number }>()

    // ── Chat / session helpers ────────────────────────────────────
    // Get the active SessionState for a chat (null if none).
    function getActiveSession(cid: string): SessionState | null {
      const chat = chats.get(cid)
      if (!chat?.activeSessionId) return null
      return chat.sessions[chat.activeSessionId] ?? null
    }

    // Get the SessionState for a specific session id in a chat.
    function getSession(cid: string, sessionId: string): SessionState | null {
      return chats.get(cid)?.sessions[sessionId] ?? null
    }

    // Add a new session to a chat. By default it becomes the active
    // one. If makeActive is false, the previously active session
    // (if any) stays active — useful for /fork where the fork
    // might or might not replace the current session.
    function addSession(cid: string, state: SessionState, makeActive = true) {
      let chat = chats.get(cid)
      if (!chat) {
        chat = { activeSessionId: null, sessions: {}, order: [] }
        chats.set(cid, chat)
      }
      chat.sessions[state.sessionId] = state
      // Move to front of order (most recent first).
      chat.order = [state.sessionId, ...chat.order.filter((id) => id !== state.sessionId)]
      sessionToChat.set(state.sessionId, cid)
      if (makeActive || !chat.activeSessionId) {
        chat.activeSessionId = state.sessionId
      }
      persistChats()
    }

    // Switch the active session in a chat. No-op if the session
    // doesn't belong to the chat.
    function setActiveSession(cid: string, sessionId: string) {
      const chat = chats.get(cid)
      if (!chat) return
      if (!chat.sessions[sessionId]) return
      chat.activeSessionId = sessionId
      chat.order = [sessionId, ...chat.order.filter((id) => id !== sessionId)]
      persistChats()
    }

    // Remove a session from a chat. If it was active, promote the
    // next-most-recent remaining session (or null if the chat
    // becomes empty).
    function removeSession(cid: string, sessionId: string) {
      const chat = chats.get(cid)
      if (!chat) return
      delete chat.sessions[sessionId]
      chat.order = chat.order.filter((id) => id !== sessionId)
      sessionToChat.delete(sessionId)
      if (chat.activeSessionId === sessionId) {
        chat.activeSessionId = chat.order[0] ?? null
      }
      if (chat.order.length === 0) {
        chats.delete(cid)
      }
      persistChats()
    }

    // DEBUG-2026-06-21: pick the next-most-recent session for `cid` that
    // is NOT `excludeId`. Used by dispatchPrompt to fall back when the
    // resolved session has been pruned server-side. Async because we have
    // to validate each candidate against the server (some archived entries
    // may also be gone).
    async function pickFallbackSession(cid: string, excludeId: string): Promise<string | null> {
      const chat = chats.get(cid)
      if (!chat) return null
      for (const sid of chat.order) {
        if (sid === excludeId) continue
        const res = await client.session.get({ path: { id: sid } }).catch(() => null)
        const data = res as { error?: unknown; data?: unknown } | null
        if (data?.data) return sid
      }
      return null
    }

    // Find the chat that owns a session id. Uses the reverse index
    // so it's O(1).
    function chatOf(sessionId: string): string | null {
      return sessionToChat.get(sessionId) ?? null
    }

    // Load existing chats on startup. File format is a plain JSON
    // object keyed by chat id; supports the v1 (single-session per
    // chat) and v2 (multi-session) shapes — v1 entries are migrated
    // on load to the v2 shape.
    const sessionsFileExists = yield* Effect.promise(() => Bun.file(SESSIONS_FILE).exists())
    if (sessionsFileExists) {
      try {
        const data = (yield* Effect.promise(() => Bun.file(SESSIONS_FILE).json())) as Record<string, any>
        for (const [cid, entry] of Object.entries(data)) {
          if (!entry) continue
          // v2 shape: { active, sessions: { sid: state }, order: [] }
          if (entry.sessions && typeof entry.sessions === "object") {
            const chat: ChatState = { activeSessionId: entry.active ?? null, sessions: {}, order: [] }
            for (const [sid, raw] of Object.entries(entry.sessions as Record<string, any>)) {
              const s = { ...(raw as object), streamMsgId: null, lastStreamEdit: null, inflight: false, inflightWait: null, inflightWaitTimer: null }
              chat.sessions[sid] = s as SessionState
              chat.order.push(sid)
              sessionToChat.set(sid, cid)
            }
            if (Array.isArray(entry.order)) {
              // Trust the persisted order, but reconcile in case
              // it mentions sessions that no longer exist.
              chat.order = entry.order.filter((id: string) => chat.sessions[id])
            } else {
              chat.order.reverse()  // persisted most-recent-last; we want first
            }
            // If active is missing or refers to a deleted session,
            // fall back to the first ordered session.
            if (!chat.activeSessionId || !chat.sessions[chat.activeSessionId]) {
              chat.activeSessionId = chat.order[0] ?? null
            }
            chats.set(cid, chat)
            continue
          }
          // v1 shape: { [cid]: { sessionId, lastSent, ... } } — single session per chat
          if (typeof entry === "object" && "sessionId" in entry) {
            const state = { ...(entry as object), streamMsgId: null, lastStreamEdit: null, inflight: false, inflightWait: null, inflightWaitTimer: null } as SessionState
            chats.set(cid, { activeSessionId: state.sessionId, sessions: { [state.sessionId]: state }, order: [state.sessionId] })
            sessionToChat.set(state.sessionId, cid)
          }
        }
        const totalSessions = [...chats.values()].reduce((sum, c) => sum + c.order.length, 0)
        yield* Effect.logDebug("telegram loaded persisted chats", { chats: chats.size, sessions: totalSessions })
      } catch (e) {
        yield* Effect.logWarning("telegram failed to load sessions", { message: eMsg(e) })
      }
    } else {
      yield* Effect.logDebug("telegram no persisted sessions file, starting fresh")
    }

    // Persist chats to disk (debounced). Serializes the active
    // session id plus the full sessions record per chat.
    let persistTimer: ReturnType<typeof setTimeout> | null = null
    function persistChats() {
      if (persistTimer) clearTimeout(persistTimer)
      persistTimer = setTimeout(async () => {
        try {
          const snapshot: Record<string, { active: string | null; sessions: Record<string, SessionState>; order: string[] }> = {}
          for (const [cid, chat] of chats.entries()) {
            snapshot[cid] = { active: chat.activeSessionId, sessions: chat.sessions, order: chat.order }
          }
          await Bun.write(SESSIONS_FILE, JSON.stringify(snapshot, null, 2))
        } catch (e) {
          log.error("failed to persist sessions", { message: eMsg(e) })
        }
      }, 500)
    }
    // (Old name was `persistSessions`; the multi-session refactor
    // renamed it to `persistChats` to match the new data shape.)

    // ── Message handler ────────────────────────────────────────────
    // The Telegraf context type is hard to express inline (the
    // message update is a discriminated union of many shapes), so
    // we keep `ctx: any` here and narrow the fields we read at
    // use-sites. The trade-off: the body of the handler is
    // type-checked at the access points, not the parameter.
    bot.on("message", async (ctx: any) => {
      const cid = String(ctx.chat.id)
      log.debug("message received", { cid, chatType: ctx.chat.type, keys: Object.keys(ctx.message ?? {}).filter((k) => !["date", "chat", "from", "message_id"].includes(k)) })
      if (!allow(cid)) {
        log.debug("chat not in allowlist, ignoring", { cid })
        return
      }
      // In group chats, only respond when @-mentioned or to commands.
      // Uses the botUsername cached at startup; if getMe failed or
      // is still in flight, fall through and let the message be
      // processed (commands always work; mention-gated text only
      // works once we know the username).
      if (ctx.chat.type !== "private") {
        const isCommand = (ctx.message?.text ?? "").startsWith("/")
        if (!isCommand && botUsername && !(ctx.message?.text ?? "").includes(botUsername)) {
          log.debug("group message without mention, ignoring")
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
      // pendingCustomQuestion is { questionID, questionIndex } (not just qid)
      // so we know which slot to fill in the multi-question batch.
      const pendingCustom = pendingCustomQuestion.get(cid)
      if (pendingCustom && !text.startsWith("/")) {
        const { questionID, questionIndex } = pendingCustom
        const pending = pendingQuestions.get(questionID)
        if (pending) {
          const slot = pendingAnswers.get(questionID)
          if (!slot) {
            // State desync — pendingQuestions exists but no slot. Reset both.
            pendingCustomQuestion.delete(cid)
            pendingQuestions.delete(questionID)
            await reply(cid, "❌ Question state lost, please resend your prompt.")
            return
          }
          slot[questionIndex] = [text]
          pendingCustomQuestion.delete(cid)
          const allAnswered = pending.questions.every((_, i) => slot[i] && slot[i].length > 0)
          if (!allAnswered) {
            const total = pending.questions.length
            await reply(cid, `✅ Saved custom answer for question ${questionIndex + 1}/${total}. Answer the remaining questions to submit.`)
            return
          }
          // All answered — post and clean up.
          await answerQuestion(cid, questionID, slot, pending.sessionID)
          pendingQuestions.delete(questionID)
          pendingAnswers.delete(questionID)
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

        if (cmd === "restart") {
          await ctx.reply("🔄 Restarting...")
          // Exit with 143 (SIGTERM) so the restart loop picks it up
          setTimeout(() => process.exit(143), 100)
          return
        }
        if (cmd === "version" || cmd === "v") {
          await ctx.reply(`Build: 0.0.0-dev-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${new Date().toISOString().slice(11, 16).replace(":", "")}`)
          return
        }
        if (cmd === "start") {
          await ctx.reply("👋 Welcome! Send me any request and I'll help you out.\n\nCommands:\n/new - create session\n/abort - stop task\n/status - show session\n/share - get share link\n/model - show or switch model\n/compact - summarize this session\n/fork - fork at last user message\n/retry - resend last prompt\n/restart - restart bot\n/sessions - list & switch sessions\n/whoami - show your chat ID\n/help - show this")
          return
        }
        if (cmd === "new") {
          const sid = await createSession(cid)
          if (!sid) { await ctx.reply("Failed to create session."); return }
          await ctx.reply(`✅ New session created: ${sid.slice(0, 8)}...`)
          return
        }
        if (cmd === "abort") {
          const session = getActiveSession(cid)
          if (!session) { await ctx.reply("No active session."); return }
          await client.session.abort({ path: { id: session.sessionId } }).catch(() => {})
          session.lastSent = null
          session.lastReasoning = null
          session.userPrompt = null
          session.streamMsgId = null
          session.lastStreamEdit = null
          clearPendingStreamEdit(cid)
          stopTyping(cid)
          await ctx.reply("✅ Task aborted.")
          return
        }
        if (cmd === "status") {
          safe(async () => {
            const session = getActiveSession(cid)
            if (!session) { await ctx.reply("No active session. Send /new to create one."); return }
            // Pull server-side session state for the model + message count.
            // The shape of session.get() varies across opencode versions
            // (we hit "omlx/undefined" before), so read defensively.
            const sesRes = await client.session.get({ path: { id: session.sessionId } }).catch(() => null)
            const data = (sesRes?.data as unknown as SessionLike | undefined) ?? {}
            // The server's session.get() can return `model` as either a
            // { providerID, modelID } object or a flat string, depending
            // on version. Sometimes modelID is itself an object (e.g.
            // { name, id }) — keep recursing one level. Always extract
            // a `providerID/modelID` string, or null.
            let modelStr: string | null = null
            // The server's session model field has been observed in
            // several shapes across opencode versions (string, flat
            // object, or nested). The body is checked at runtime
            // with type guards so we use `unknown` and recurse.
            const extract = (v: unknown): string | null => {
              if (typeof v === "string") {
                return v.includes("/") ? v : null
              }
              if (!v || typeof v !== "object") return null
              // After typeof === "object" guard, treat as a record
              // for property access. Cast through unknown so TS
              // doesn't complain about the dynamic shape.
              const o = v as Record<string, unknown>
              // Common shapes:
              //   { providerID, modelID }          (canonical)
              //   { providerID, modelID: { id } }  (nested — modelID.id)
              //   { provider, model }              (alt names)
              //   { name, id }                     (model object without provider)
              const pid = (o.providerID ?? o.provider) as string | undefined
              let mid = (o.modelID ?? o.model ?? o.id) as unknown
              if (mid && typeof mid === "object") {
                const m = mid as Record<string, unknown>
                mid = m.id ?? m.modelID ?? m.name
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
            // SessionLike doesn't expose a top-level modelID
            // (the server returns model as a nested object), but
            // defensive read for an alternative flat shape.
            modelStr = extract(data.model) ?? extract((data as { modelID?: unknown }).modelID)
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
            // tokens.modelContextLimit is null at this layer (config.ts
            // doesn't have the client); look it up from the dynamic
            // catalog when we know which model is active. Falls back
            // to the static map if the server is unreachable.
            const curModel = getCurrentModel()
            const modelCtxLimit = curModel
              ? await getModelContextLimit(client, curModel.providerID, curModel.modelID)
              : null
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
            // Status state — read from server data, fall back to "idle"
            // (most queries land here).
            const state = data.status ?? "idle"
            // For multi-session chats, label the active session as
            // "N of M" so the user knows there are others.
            const chat = chats.get(cid)
            const totalChats = chat?.order.length ?? 1
            const idx = chat ? chat.order.indexOf(session.sessionId) + 1 : 1
            const sessionLabel = totalChats > 1 ? `\`${session.sessionId.slice(0, 8)}…\` (${idx}/${totalChats})` : `\`${session.sessionId.slice(0, 8)}…\``
            const lines: string[] = [
              `📋 Session: ${sessionLabel}`,
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
          const session = getActiveSession(cid)
          if (!session) { await ctx.reply("No active session."); return }
          const res = await client.session.share({ path: { id: session.sessionId } }).catch(() => null)
          const url = res?.data?.share?.url ?? `Session ${session.sessionId}`
          await ctx.reply(`🔗 ${url}`)
          return
        }
        if (cmd === "help") {
          await ctx.reply("Commands:\n/new - new session (active)\n/abort - stop task\n/status - show session\n/share - get share link\n/model [query] - show or switch model\n/compact - summarize this session\n/fork - fork at last user message\n/retry - resend last prompt\n/restart - restart bot\n/sessions - list & switch sessions\n/to <id> <msg> - send a message to a specific session\n/whoami - show your chat ID\n/help - show this\n\nOr just send any request!")
          return
        }
        if (cmd === "whoami") {
          await ctx.reply(`Your chat ID: \`${cid}\``, { parse_mode: "Markdown" })
          return
        }
        if (cmd === "model") {
          safe(async () => {
            const s = getActiveSession(cid)
            if (!s) { await reply(cid, "No active session. Send /new to create one."); return }
            const catalog = await getModelCatalog(client)
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
            const s = getActiveSession(cid)
            if (!s) { await reply(cid, "No active session. Send /new to create one."); return }
            const msgs = await client.session.messages({ path: { id: s.sessionId } }).catch(() => null)
            const list = (msgs?.data as unknown as SessionMessageListItem[] | undefined) ?? []
            const lastUser = [...list].reverse().find((m) => m.info?.role === "user")
            if (!lastUser) {
              await reply(cid, "❌ Nothing to compact — no user messages yet.")
              return
            }
            // Need a model to summarize with. Use the session's current model
            // if known, else the catalog's first.
            const sesRes = await client.session.get({ path: { id: s.sessionId } }).catch(() => null)
            const cur = (sesRes?.data as unknown as SessionLike | undefined)?.model
            let providerID = typeof cur === "object" && cur !== null ? cur.providerID : undefined
            let modelID = typeof cur === "object" && cur !== null ? cur.modelID : undefined
            if (!providerID || !modelID) {
              const catalog = await getModelCatalog(client)
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
            }).catch((e: unknown) => ({ error: e }))
            if ((res as { error?: unknown })?.error) {
              const err = (res as ErrorLike).error
              const msg = err?.data?.message ?? err?.message ?? "unknown"
              await reply(cid, `❌ Compact failed: ${msg}`)
              return
            }
            await reply(cid, "✅ Compacted.")
          }, "compact handler")
          return
        }
        if (cmd === "fork") {
          safe(async () => {
            const s = getActiveSession(cid)
            if (!s) { await reply(cid, "No active session. Send /new to create one."); return }
            const msgs = await client.session.messages({ path: { id: s.sessionId } }).catch(() => null)
            const list = (msgs?.data as unknown as SessionMessageListItem[] | undefined) ?? []
            const lastUser = [...list].reverse().find((m): m is SessionMessageListItem & { info: NonNullable<SessionMessageListItem["info"]> } => m.info?.role === "user")
            if (!lastUser) {
              await reply(cid, "❌ Nothing to fork — no user messages yet.")
              return
            }
            const res = await client.session.fork({
              path: { id: s.sessionId },
              body: { messageID: lastUser.info.id },
            }).catch((e: unknown) => ({ error: e }))
            const newId = (res as { data?: { id?: string } })?.data?.id
            if (!newId) {
              const err = (res as ErrorLike).error
              const msg = err?.data?.message ?? err?.message ?? "unknown"
              await reply(cid, `❌ Fork failed: ${msg}`)
              return
            }
            // Switch active session to the fork. addSession handles
            // moving the old active to the back of the chat's order
            // and re-pointing the active id.
            addSession(cid, { sessionId: newId, lastSent: null, lastReasoning: null, userPrompt: null, streamMsgId: null, lastStreamEdit: null, inflight: false, inflightWait: null, inflightWaitTimer: null, lastRetryAttempt: null })
            await reply(cid, `🍴 Forked!\nOld: \`${s.sessionId.slice(0, 8)}…\`\nNew: \`${newId.slice(0, 8)}…\``)
          }, "fork handler")
          return
        }
        if (cmd === "retry") {
          safe(async () => {
            const s = getActiveSession(cid)
            if (!s) { await reply(cid, "No active session. Send /new to create one."); return }
            const msgs = await client.session.messages({ path: { id: s.sessionId } }).catch(() => null)
            const list = (msgs?.data as unknown as SessionMessageListItem[] | undefined) ?? []
            const lastUser = [...list].reverse().find((m) => m.info?.role === "user")
            if (!lastUser) {
              await reply(cid, "❌ Nothing to retry — no user messages yet.")
              return
            }
            // Reconstruct the text from text parts. Skip synthetic/internal parts.
            const text = (lastUser.parts ?? [])
              .filter((p): p is { type: string; text: string; synthetic?: boolean } => p.type === "text" && !p.synthetic)
              .map((p) => p.text)
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
            s.lastStreamEdit = null
            clearPendingStreamEdit(cid)
            stopTyping(cid)
            const res = await dispatchPrompt(cid, [{ type: "text", text }], text)
            if (res?.error) await reply(cid, `Error: ${res.error}`)
          }, "retry handler")
          return
        }
        if (cmd === "sessions") {
          safe(async () => {
            const chat = chats.get(cid)
            if (!chat || chat.order.length === 0) {
              await reply(cid, "No sessions yet. Send any message to create one, or /new.")
              return
            }
            // Pull titles for each known session in parallel. Skip
            // ones that 404 server-side (deleted) and prune them
            // from the chat so the listing stays clean. Parallel
            // fetch keeps the listing snappy on chats with many
            // sessions — sequential awaits would add N round-trips.
            const fetches = await Promise.all(
              chat.order.map(async (sid) => {
                const res = await client.session.get({ path: { id: sid } }).catch(() => null)
                const resData = res as { error?: unknown; data?: SessionLike } | null
                if (!res || resData?.error || !resData?.data) {
                  return { sid, ok: false as const }
                }
                return { sid, ok: true as const, title: resData.data.title ?? "(untitled)" }
              }),
            )
            const known: Array<{ id: string; title: string; active: boolean }> = []
            for (const f of fetches) {
              if (!f.ok) {
                removeSession(cid, f.sid)
                continue
              }
              known.push({ id: f.sid, title: f.title, active: f.sid === chat.activeSessionId })
            }
            if (known.length === 0) {
              await reply(cid, "No sessions yet. Send any message to create one, or /new.")
              return
            }
            const lines = known.map((k) => {
              const short = k.id.slice(0, 8)
              const mark = k.active ? " ← active" : ""
              return `  ${short}…  ${trunc(k.title, 40)}${mark}`
            })
            // Inline keyboard. Cap at 8 to stay readable; Telegram
            // chokes on very long button stacks.
            const rows = known.slice(0, 8).map((k) => [
              Markup.button.callback(
                `${k.active ? "✅ " : "  "}${k.id.slice(0, 8)}… ${trunc(k.title, 24)}`,
                `sess:switch:${k.id}`,
              ),
            ])
            // Add a /new button so the user can grow the list without
            // typing the command separately.
            rows.push([Markup.button.callback("➕ New session", "sess:new")])
            const btns = Markup.inlineKeyboard(rows)
            await reply(cid, `📂 Sessions (${known.length}):\n${lines.join("\n")}\n\nTap to switch.`, btns)
          }, "sessions handler")
          return
        }
        if (cmd === "to") {
          // Route a prompt to a specific session by id. The session
          // must already belong to this chat (or it 404s — the user
          // can /sessions first to import one). The rest of the
          // message after the id is sent as a normal prompt.
          const target = args[0]
          if (!target) {
            await reply(cid, "Usage: /to <sessionId> <message>")
            return
          }
          // Accept either the full session id or a unique 8-char
          // prefix — the prefix form is what /sessions shows.
          const chat = chats.get(cid)
          let resolved: string | null = null
          if (chat?.sessions[target]) {
            resolved = target
          } else {
            const match = chat?.order.find((id) => id.startsWith(target))
            if (match) resolved = match
          }
          if (!resolved) {
            await reply(cid, `❌ Session \`${target}\` not in this chat. Use /sessions to see available ones.`)
            return
          }
          const promptText = args.slice(1).join(" ").trim()
          if (!promptText) {
            await reply(cid, "Usage: /to <sessionId> <message>")
            return
          }
          setActiveSession(cid, resolved)
          const res = await dispatchPrompt(cid, [{ type: "text", text: promptText }], promptText, { targetSessionId: resolved })
          if (res?.error) await reply(cid, `Error: ${res.error}`)
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
      log.debug("callback_query event fired", { data: ctx.callbackQuery?.data })
      // Telegraf 4.x: answer via ctx.telegram.answerCallbackQuery
      if (ctx.telegram?.answerCallbackQuery) {
        await ctx.telegram.answerCallbackQuery(ctx.callbackQuery?.id).catch(() => {})
      } else if (typeof ctx.answerCallbackQuery === "function") {
        await ctx.answerCallbackQuery().catch(() => {})
      } else {
        log.warn("answerCallbackQuery not found", { keys: Object.keys(ctx) })
      }
      const data = ctx.callbackQuery?.data
      if (!data) return
      const msg = ctx.callbackQuery.message
      if (!msg) return
      const cid = String(msg.chat.id)
      if (!allow(cid)) {
        log.debug("callback from non-allowlisted chat, ignoring", { cid })
        return
      }
      const session = getActiveSession(cid)

      // ── Model picker (/model inline buttons) ─────────────────────
      // Format: model:<catalogIndex>  (index into KNOWN_PROVIDERS, see
      // comment on the button construction — full IDs overflow the 64
      // byte callback_data limit).
      if (data.startsWith("model:")) {
        const idx = Number.parseInt(data.slice("model:".length), 10)
        if (!Number.isFinite(idx) || idx < 0) return
        const catalog = await getModelCatalog(client)
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
        // Format: ques:<questionID>:<questionIndex>:<optionIndex | "custom">
        if (parts.length !== 4) return
        const questionID = parts[1]
        const questionIndex = parseInt(parts[2], 10)
        const answer = parts[3]
        if (answer === "custom") {
          // Set pending state — next text message will be the answer.
          // Stored as {questionID, questionIndex} so a chat that's mid-custom
          // on Q1 can still answer Q2 by tapping another button.
          pendingCustomQuestion.set(cid, { questionID, questionIndex })
          const total = pendingQuestions.get(questionID)?.questions.length ?? 1
          const num = total > 1 ? ` (${questionIndex + 1}/${total})` : ""
          await reply(cid, `✏️ Please type your answer for question${num}:`)
          return
        }
        // Option button — look up the label from stored question
        const pending = pendingQuestions.get(questionID)
        if (!pending) {
          await reply(cid, "❌ Question expired, please resend your prompt.")
          return
        }
        if (isNaN(questionIndex) || questionIndex < 0 || questionIndex >= pending.questions.length) {
          await reply(cid, "❌ Invalid question index.")
          return
        }
        const options = pending.questions[questionIndex].options
        const optionIndex = parseInt(answer, 10)
        if (isNaN(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
          await reply(cid, "❌ Invalid option.")
          return
        }
        const label = options[optionIndex].label
        // Accumulate. The server expects payload.answers to be one slot per
        // question (string[][]), so we must wait until every question in the
        // batch is answered before posting — otherwise an early post for
        // "just Q1" leaves Q2 unanswered and the server expires the request.
        const slot = pendingAnswers.get(questionID)
        if (!slot) {
          await reply(cid, "❌ Question state lost, please resend your prompt.")
          return
        }
        slot[questionIndex] = [label]
        const allAnswered = pending.questions.every((_, i) => slot[i] && slot[i].length > 0)
        if (!allAnswered) {
          const total = pending.questions.length
          await reply(cid, `✅ Saved answer for question ${questionIndex + 1}/${total}. Answer the remaining questions to submit.`)
          return
        }
        // All questions answered — post the full batch and clean up.
        await answerQuestion(cid, questionID, slot, pending.sessionID)
        pendingQuestions.delete(questionID)
        pendingAnswers.delete(questionID)
        return
      }

      // ── New session from /sessions picker ────────────────────────
      if (data === "sess:new") {
        safe(async () => {
          const sid = await createSession(cid)
          if (!sid) { await reply(cid, "❌ Failed to create session."); return }
          const newState = getActiveSession(cid)
          const title = newState ? `\`${sid.slice(0, 8)}…\`` : sid.slice(0, 8)
          await reply(cid, `✅ New session created and active: ${title}`)
        }, "sess new handler")
        return
      }

      // ── Session switch from /sessions list ───────────────────────
      // Multi-session: the click might be for the active session
      // (no-op) or any other session the chat owns. If the session
      // id isn't in this chat, it could be a session the user saw
      // from a different chat — fetch and import it as a new
      // session in this chat instead of erroring.
      if (data.startsWith("sess:")) {
        const parts = data.split(":")
        if (parts.length !== 3 || parts[1] !== "switch") return
        const newId = parts[2]
        safe(async () => {
          // No-op if already active in this chat.
          if (getActiveSession(cid)?.sessionId === newId) {
            await reply(cid, `Already on \`${newId.slice(0, 8)}…\``)
            return
          }
          // If the session is already known to this chat, just
          // promote it to active. Otherwise verify the session
          // exists server-side and import it.
          let state = getSession(cid, newId)
          let title = "(untitled)"
          if (!state) {
            const ver = await client.session.get({ path: { id: newId } }).catch(() => null)
            const verData = ver as { error?: unknown; data?: SessionLike } | null
            if (!ver || verData?.error || !verData?.data) {
              await reply(cid, `❌ Session not found: ${newId.slice(0, 8)}…`)
              return
            }
            title = verData.data.title ?? "(untitled)"
            state = { sessionId: newId, lastSent: null, lastReasoning: null, userPrompt: null, streamMsgId: null, lastStreamEdit: null, inflight: false, inflightWait: null, inflightWaitTimer: null, lastRetryAttempt: null }
            // makeActive=true so addSession switches the active id.
            addSession(cid, state)
          } else {
            setActiveSession(cid, newId)
            // Pull the title for the active session so the user sees
            // it in the confirmation. We do this in the background;
            // it's a small request and the user has just clicked
            // a button, so a beat of latency is fine.
            const ver = await client.session.get({ path: { id: newId } }).catch(() => null)
            const verData = ver as { error?: unknown; data?: SessionLike } | null
            if (ver && !verData?.error && verData?.data) title = verData.data.title ?? "(untitled)"
          }
          // Reset per-session stream/inflight bookkeeping on switch
          // so a freshly-activated session starts clean.
          if (state) {
            state.streamMsgId = null
            state.lastStreamEdit = null
            state.inflight = false
            state.userPrompt = null
            state.lastSent = null
            state.lastReasoning = null
            if (state.inflightWaitTimer) clearTimeout(state.inflightWaitTimer)
            state.inflightWait = null
            state.inflightWaitTimer = null
          }
          stopTyping(cid)
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
        log.debug("permission response", { res })
        if (res.error) {
          const err = res.error as { _tag?: string; message?: string }
          // PermissionNotFoundError means user pressed a button twice or the request
          // already resolved — not a real error, just ignore silently.
          if (err._tag === "PermissionNotFoundError") {
            log.debug("permission already resolved, ignoring duplicate click")
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
    // Reconnect backoff for the SSE event stream. Reset to 0 on
    // successful subscribe.
    const RECONNECT_BASE_MS = 1000
    const RECONNECT_MAX_MS = 60_000
    let reconnectAttempts = 0
    ;(async () => {
      while (true) {
        try {
          log.debug("connecting event stream")
          const events = await client.event.subscribe()
          reconnectAttempts = 0
          log.debug("event stream connected")
          for await (const ev of events.stream) {
            try {
              log.debug("event", { type: ev.type })
              if (ev.type === "session.status") {
                const props = ev.properties as { sessionID: string; status: { type: string } }
                const cid = chatOf(props.sessionID)
                if (cid) {
                  const s = getActiveSession(cid)
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
                      s.lastStreamEdit = null
                      s.inflight = false
                      // Reset the retry-notify dedup counter so the next
                      // prompt's first attempt is reported again.
                      s.lastRetryAttempt = null
                      // Clear any pending question state for this session —
                      // the server is done with the current turn, so any
                      // unanswered questions are moot. Prevents the bot
                      // from holding a stale pendingQuestions entry that
                      // a later (different) question.asked could collide
                      // with if it shared the qid by accident.
                      for (const [qid, p] of pendingQuestions) {
                        if (p.sessionID === props.sessionID) {
                          pendingQuestions.delete(qid)
                          pendingAnswers.delete(qid)
                        }
                      }
                      // Wake any dispatchPrompt waiting for idle. The
                      // safety timer is cleared because the real idle
                      // event arrived in time.
                      if (s.inflightWaitTimer) clearTimeout(s.inflightWaitTimer)
                      if (s.inflightWait) {
                        s.inflightWait()
                        s.inflightWait = null
                        s.inflightWaitTimer = null
                      }
                      clearPendingStreamEdit(cid)
                      stopTyping(cid)
                    } else if (props.status?.type === "retry") {
                      // Provider error → server is backing off and will retry.
                      // Without this the bot stays silent (just "typing") and the
                      // user can't tell anything went wrong. Notify once per
                      // attempt, deduped by attempt number so short backoffs
                      // (2s/4s/8s) don't spam the chat.
                      const r = props.status as {
                        type: "retry"
                        attempt: number
                        message: string
                        next: number
                        action?: { title: string; message: string; label: string; link?: string }
                      }
                      if (s.lastRetryAttempt !== r.attempt) {
                        s.lastRetryAttempt = r.attempt
                        const waitSec = Math.max(0, Math.ceil((r.next - Date.now()) / 1000))
                        const link = r.action?.link ? `\n${r.action.title}: ${r.action.link}` : ""
                        await reply(
                          cid,
                          `⏳ Provider error, retrying in ~${waitSec}s (attempt ${r.attempt}): ${trunc(r.message, 250)}${link}`,
                        )
                      }
                      startTyping(cid)
                    } else {
                      // busy — show "typing" indicator
                      startTyping(cid)
                    }
                  }
                }
                continue
              }

              // Session error — notify the user. Without this the bot goes
              // silent when the model or a tool fails, and the user has no
              // way to tell that anything went wrong. Also wake any
              // dispatchPrompt waiting for idle so it doesn't hang on the
              // 5s safety timer.
              if (ev.type === "session.error") {
                const err = ev.properties as {
                  sessionID?: string
                  error?: { name?: string; message?: string; data?: { message?: string } }
                }
                log.debug("session.error", { err })
                const sid = err.sessionID
                if (!sid) continue
                const cid = chatOf(sid)
                if (!cid) continue
                const s = getActiveSession(cid)
                if (s) {
                  s.lastSent = null
                  s.lastReasoning = null
                  s.userPrompt = null
                  s.streamMsgId = null
                  s.lastStreamEdit = null
                  s.inflight = false
                  s.lastRetryAttempt = null
                  clearPendingStreamEdit(cid)
                  if (s.inflightWaitTimer) clearTimeout(s.inflightWaitTimer)
                  if (s.inflightWait) {
                    s.inflightWait()
                    s.inflightWait = null
                    s.inflightWaitTimer = null
                  }
                  clearPendingStreamEdit(cid)
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
                log.debug("permission.asked", { perm })
                const cid = chatOf(perm.sessionID)
                if (!cid) {
                  log.debug("permission session not found in sessions map", { knownSessionIds: [...sessionToChat.keys()] })
                  continue
                }

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
                log.debug("permission buttons sent")
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
                log.debug("question.asked", { q })
                const cid = chatOf(q.sessionID)
                if (!cid) {
                  log.debug("question session not found")
                  continue
                }
                // Store all questions' options under a single qid, and seed
                // pendingAnswers with empty slots (one per question). The
                // callback handler fills in slots and posts when all are
                // answered. See 2026-06-21-multi-question-bug.md for the
                // previous bug where looping over q.questions and calling
                // pendingQuestions.set(q.id, …) inside the loop overwrote
                // earlier questions — the first answer would delete the
                // whole entry, leaving the next question's button click
                // resolving to "Question expired".
                pendingQuestions.set(q.id, {
                  sessionID: q.sessionID,
                  questions: q.questions.map((qq) => ({ options: qq.options })),
                })
                pendingAnswers.set(
                  q.id,
                  q.questions.map(() => [] as string[]),
                )
                for (let qi = 0; qi < q.questions.length; qi++) {
                  const question = q.questions[qi]
                  const head = question.header ? `[${question.header}]\n` : ""
                  // Number the question when there are >1 so users can
                  // tell which one Telegram is asking about.
                  const qNum = q.questions.length > 1 ? ` (${qi + 1}/${q.questions.length})` : ""
                  const text = `❓ ${head}${question.question}${qNum}`
                  // Build one button row per option
                  const rows = question.options.map((opt, i) => [
                    Markup.button.callback(opt.label, `ques:${q.id}:${qi}:${i}`),
                  ])
                  // Add a custom answer button if there are no options or tool allows it
                  if (question.options.length === 0) {
                    rows.push([Markup.button.callback("✏️ Custom answer", `ques:${q.id}:${qi}:custom`)])
                  }
                  const btns = Markup.inlineKeyboard(rows)
                  await reply(cid, text, btns)
                  log.debug("question buttons sent", { header: question.header, questionIndex: qi })
                }
                continue
              }

              // Message part updates
              if (ev.type !== "message.part.updated") continue
              const part = ev.properties.part
              const cid = chatOf(part.sessionID as string)
              if (!cid) continue
              const s = getActiveSession(cid)
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
                    scheduleStreamEdit(s, cid, rest)
                  }
                  continue
                }
                s.lastSent = p.text
                scheduleStreamEdit(s, cid, p.text)
              } else if (part.type === "reasoning") {
                // Reasoning breaks the text stream — close it first so the
                // next text chunk opens a fresh message.
                const p = part as { text: string }
                if (!p.text || !p.text.trim()) continue
                if (s.lastReasoning === p.text) continue
                s.lastReasoning = p.text
                closeStream(s, cid)
                send(cid, `🧠 Thinking:\n\n${p.text}`)
              } else if (part.type === "tool") {
                // Each tool completion is its own notification, not part
                // of the streaming text message.
                const p = part as { tool: string; state: { status: string; title?: string } }
                if (p.state.status === "completed" && p.state.title) {
                  closeStream(s, cid)
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
                // The model sometimes hallucinates bogus paths ("undefined")
                // or empty files when it loses track of an edit. Drop
                // those before rendering so the user doesn't see
                // "📝 1 file changed: undefined +0 -0".
                const realFiles = p.files.filter((f) => f.path && f.path !== "undefined")
                if (realFiles.length === 0) continue
                closeStream(s, cid)
                const lines = realFiles.map((f) => {
                  const add = f.additions ?? 0
                  const del = f.deletions ?? 0
                  return `  ${f.path}  +${add} -${del}`
                })
                send(cid, `📝 ${realFiles.length} file${realFiles.length === 1 ? "" : "s"} changed:\n${lines.join("\n")}`)
              }
            } catch (evErr) {
              log.error("event loop inner error", { message: eMsg(evErr) })
            }
          }
        } catch (streamErr) {
          // Exponential backoff: 1s, 2s, 4s, 8s, ... up to 60s, with
          // up to 30% jitter so a fleet of bots reconnecting at once
          // don't synchronize into a thundering herd. Reset to 0 on
          // the next successful subscribe.
          const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts)
          const jitter = base * 0.3 * Math.random()
          const delay = Math.round(base + jitter)
          reconnectAttempts++
          log.warn("event stream disconnected, reconnecting", { attempt: reconnectAttempts, delayMs: delay, message: eMsg(streamErr) })
          await new Promise(r => setTimeout(r, delay))
        }
      }
    })()

    // ── Register bot commands so Telegram shows the command menu ──────────
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
    ]).then(() => log.debug("setMyCommands done")).catch((e) => log.error("setMyCommands", { message: eMsg(e) }))

    // ── Launch ─────────────────────────────────────────────────────
    // 409 Conflict: another getUpdates request is active (a previous bot
    // instance still holds the long-poll). Telegram expires that session
    // within ~5-10min after a clean stop, but SIGKILL of the old process
    // can leave the server-side session alive longer. Use a longer base
    // (30s) and cap (120s) so we don't hammer telegram while waiting for
    // the server-side session to expire.
    const launchWithRetry = async () => {
      let attempt = 0
      while (true) {
        try {
          await bot.launch()
          log.debug("bot.launch() unexpectedly resolved")
          return
        } catch (err) {
          attempt++
          const msg = eMsg(err)
          const is409 = /409/.test(msg)
          // 409: 30s base, doubling up to 120s. non-409: 5s fixed.
          const delay = is409 ? Math.min(120_000, 30_000 * Math.min(4, attempt)) : 5_000
          log.error("bot.launch()", { attempt, message: msg, retryIn: delay })
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    void launchWithRetry()

    // Clean up typing timers on shutdown so node doesn't keep the
    // event loop alive with stray intervals if bot.stop() races.
    const cleanupTyping = () => {
      for (const cid of [...typingTimers.keys()]) stopTyping(cid)
    }
    // Flush any pending debounced writes so SIGINT (Ctrl-C) doesn't
    // drop the most recent session switches. The debounce in
    // persistChats() is 500ms; an aggressive exit would skip it.
    // Fire-and-forget: Bun.write is fast for small JSON and the
    // process is exiting so the kernel will flush the buffer
    // before the runtime tears down.
    const flushPersist = () => {
      if (!persistTimer) return
      clearTimeout(persistTimer)
      persistTimer = null
      try {
        const snapshot: Record<string, { active: string | null; sessions: Record<string, SessionState>; order: string[] }> = {}
        for (const [cid, chat] of chats.entries()) {
          snapshot[cid] = { active: chat.activeSessionId, sessions: chat.sessions, order: chat.order }
        }
        Bun.write(SESSIONS_FILE, JSON.stringify(snapshot, null, 2)).catch((e) => {
          const msg = e instanceof Error ? e.message : String(e)
          log.error("flush persist on shutdown", { message: msg })
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error("flush persist on shutdown", { message: msg })
      }
    }
    process.once("SIGINT", () => {
      cleanupTyping()
      flushPersist()
      bot.stop("SIGINT")
    })
    process.once("SIGTERM", () => {
      cleanupTyping()
      flushPersist()
      bot.stop("SIGTERM")
    })
    // Resolve the bot identity once at startup. Cached so the
    // group-chat @mention check below doesn't hit Telegram's API
    // on every incoming group message.
    let botUsername = ""
    bot.telegram.getMe()
      .then((me) => {
        const username = me.username ? `@${me.username}` : ""
        botUsername = username
        log.info("getMe success", { username: me.username })
        UI.println(UI.Style.TEXT_INFO_BOLD + "  Telegram:     ", UI.Style.TEXT_NORMAL, username || "(no username)")
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        log.warn("getMe failed", { message: msg })
        UI.println(UI.Style.TEXT_INFO_BOLD + "  Telegram:     ", UI.Style.TEXT_NORMAL, "(unverified)")
      })

    if (allowedUsers.length > 0) {
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Allowed:      ", UI.Style.TEXT_NORMAL, allowedUsers.join(", "))
    }
    UI.empty()

    // Keep process alive — bot polling runs in background
    yield* Effect.never
  }),
})

export * as Telegram from "."
