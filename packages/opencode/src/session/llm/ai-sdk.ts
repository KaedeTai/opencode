import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { type streamText } from "ai"
import { errorMessage } from "@/util/error"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

// DEBUG-2026-06-21: monotonic timing for prefill -> first-delta -> stream close.
// We attach a per-stream state object keyed by `state` (passed into every
// toLLMEvents call for a given stream) via a module-level WeakMap. Each event
// type logs a [LLM_DEBUG] line with elapsed_ms since stream start.
type DebugState = { t0: number; firstDeltaLogged: boolean; firstReasoningDeltaLogged: boolean; stepT0: number; stepIndex: number }
const streamDebug = new WeakMap<object, DebugState>()

// DEBUG-2026-06-21 LATE: wire-level fetch interceptor for minimax.
// Dumps REQUEST body (what opencode sends) and tee RESPONSE body so AI SDK
// still gets the streaming ReadableStream (we don't .text() it -- that
// would block and break SSE). The tee reader writes raw SSE bytes to file
// in the background while the rest of the pipeline consumes normally.
// Uses Object.defineProperty (writable configurable) because some runtimes
// freeze globalThis.fetch and a plain assignment throws "readonly property".
const _origFetch = globalThis.fetch
if (!(globalThis as any).__minimaxWireHooked) {
  ;(globalThis as any).__minimaxWireHooked = true
  const hookedFetch = async function hookedFetch(input: any, init?: any): Promise<Response> {
    const url = typeof input === "string" ? input : input?.url ?? ""
    const isMinimax = url.includes("minimaxi.com") || url.includes("minimax")
    if (!isMinimax) return _origFetch.call(globalThis as any, input, init)
    const dumpDir = "/tmp/opencode-wire-dump"
    const tag = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const reqPath = `${dumpDir}/${tag}-req.txt`
    const resPath = `${dumpDir}/${tag}-res.txt`
    try {
      const { mkdirSync, writeFileSync } = await import("fs")
      mkdirSync(dumpDir, { recursive: true })
      const reqBody = init?.body
      let reqStr = `[REQ ${new Date().toISOString()}] ${init?.method ?? "GET"} ${url}\n`
      const hdrs = init?.headers
      if (hdrs) reqStr += `headers: ${JSON.stringify(hdrs, null, 2)}\n`
      if (typeof reqBody === "string") reqStr += `body: ${reqBody}\n`
      else if (reqBody) reqStr += `body: <non-string, type=${typeof reqBody}>\n`
      writeFileSync(reqPath, reqStr)
    } catch {}
    const resp = await _origFetch.call(globalThis as any, input, init)
    try {
      const { mkdirSync, createWriteStream } = await import("fs")
      mkdirSync(dumpDir, { recursive: true })
      const ws = createWriteStream(resPath)
      ws.write(`[RES ${new Date().toISOString()}] status=${resp.status} ok=${resp.ok} content-type=${resp.headers.get("content-type")}\n`)
      ws.end(" [body logging disabled — Bun clone/tee corrupts ReadableStream for AI SDK SSE parser]\n")
    } catch (e) {
      try {
        const { writeFileSync } = await import("fs")
        writeFileSync(resPath, `[RES hook error] ${String(e)}`)
      } catch {}
    }
    return resp
  }
  try {
    Object.defineProperty(globalThis, "fetch", {
      value: hookedFetch,
      writable: true,
      configurable: true,
      enumerable: true,
    })
  } catch (e) {
    console.error("[LLM_DEBUG] failed to install fetch hook:", String(e))
  }
}

export function adapterState() {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: undefined as string | undefined,
    currentReasoningID: undefined as string | undefined,
    toolNames: {} as Record<string, string>,
    copilotTotalNanoAiu: undefined as number | undefined,
    // DEBUG-2026-06-21: raw chunks captured from AI SDK for the final
    // wire-level dump. See case "finish" for the write.
    rawChunks: [] as unknown[],
  }
}

// DEBUG-2026-06-21: per-stream dump path set by the caller (llm.ts)
// before streamText runs. WeakMap keeps it scoped to the state object
// without leaking across streams.
const _streamDump = new WeakMap<object, string>()
export function setStreamDumpPath(state: object, path: string) {
  _streamDump.set(state, path)
}

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  if (value == null) return undefined
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

// Temporary AI SDK bridge: Copilot billing survives only in raw provider chunks here.
// Move this extraction into @opencode-ai/llm when Copilot is handled by the native runtime.
function copilotTotalNanoAiu(value: unknown) {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const response =
    raw.response && typeof raw.response === "object" ? (raw.response as Record<string, unknown>) : undefined
  const usage = raw.copilot_usage ?? response?.copilot_usage
  if (!usage || typeof usage !== "object") return
  const total = (usage as Record<string, unknown>).total_nano_aiu
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return
  return total
}

function usage(value: unknown) {
  // DEBUG-2026-06-21: print raw usage object so we can see exactly what the
  // provider put in the response. Many providers (incl. some openai-compat
  // ones) don't populate the standard AI SDK keys and we silently drop the
  // token counts to 0 — leading to "context overflow never detected".
  console.log(`[LLM_DEBUG] raw_usage=${JSON.stringify(value)}`)
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  const entries = Object.entries({
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    totalTokens: item.totalTokens,
    reasoningTokens: item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens,
    cacheReadInputTokens: item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens,
    cacheWriteInputTokens: item.inputTokenDetails?.cacheWriteTokens,
  }).filter((entry) => entry[1] !== undefined)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function currentTextID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentTextID = id ?? state.currentTextID ?? `text-${state.text++}`
  return state.currentTextID
}

function currentReasoningID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentReasoningID = id ?? state.currentReasoningID ?? `reasoning-${state.reasoning++}`
  return state.currentReasoningID
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  // DEBUG-2026-06-21: monotonic timing per stream. `state` is the per-stream
  // adapterState object; stamp a t0 on first event and emit elapsed_ms on
  // each one. First text/reasoning delta gets a special FIRST marker so we
  // can read prefill latency at a glance.
  let dbg = streamDebug.get(state)
  if (!dbg) {
    dbg = { t0: Date.now(), firstDeltaLogged: false, firstReasoningDeltaLogged: false, stepT0: Date.now(), stepIndex: 0 }
    streamDebug.set(state, dbg)
  }
  const elapsed = Date.now() - dbg.t0
  console.log(`[LLM_DEBUG] +${elapsed}ms type=${event.type}`)
  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])

    case "finish-step":
      return Effect.sync(() => {
        const original = providerMetadata(event.providerMetadata)
        const metadata =
          state.copilotTotalNanoAiu === undefined
            ? original
            : {
                ...original,
                copilot: {
                  ...original?.copilot,
                  totalNanoAiu: state.copilotTotalNanoAiu,
                },
              }
        state.copilotTotalNanoAiu = undefined
        return [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: finishReason(event.finishReason),
            usage: usage(event.usage),
            providerMetadata: metadata,
          }),
        ]
      })

    case "finish":
      return Effect.sync(() => {
        // DEBUG-2026-06-21: write the captured raw chunks + the parsed
        // final usage to the dump file so we can see exactly what the
        // provider put on the wire. Some providers (minimax included)
        // return token counts of 0 in event.totalUsage but the raw
        // stream chunks often contain the real counts — the dump lets
        // us reconcile.
        // FIX-2026-06-22: previously this only wrote when setStreamDumpPath
        // had been called — but nobody calls setStreamDumpPath, so the
        // response phase (including rawChunks) was always lost. Always
        // write to a self-generated path now so we can see actual wire
        // data for any provider.
        const dumpPath = _streamDump.get(state) ?? `/tmp/opencode-llm-dump/response-${Date.now()}.json`
        try {
          const fs = require("fs")
          fs.mkdirSync("/tmp/opencode-llm-dump", { recursive: true })
          const responsePayload = {
            phase: "response",
            ts: new Date().toISOString(),
            rawChunkCount: state.rawChunks.length,
            rawChunks: state.rawChunks,
            finalUsage: event.totalUsage,
            finalFinishReason: event.finishReason,
            finalProviderMetadata: "providerMetadata" in event ? event.providerMetadata : undefined,
          }
          let merged: any = responsePayload
          try {
            const existing = JSON.parse(fs.readFileSync(dumpPath, "utf8"))
            merged = { ...existing, ...responsePayload }
          } catch {
            /* no existing — write response-only */
          }
          fs.writeFileSync(dumpPath, JSON.stringify(merged, null, 2))
          console.log(`[LLM_DEBUG] response_dump_written path=${dumpPath} rawChunks=${state.rawChunks.length}`)
        } catch (e) {
          console.log(`[LLM_DEBUG] dump_failed error=${e instanceof Error ? e.message : String(e)}`)
        }
        const events = [
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage: usage(event.totalUsage),
            providerMetadata: "providerMetadata" in event ? providerMetadata(event.providerMetadata) : undefined,
          }),
        ]
        return Object.assign(state, adapterState()), events
      })

    case "text-start":
      return Effect.sync(() => {
        state.currentTextID = currentTextID(state, event.id)
        return [
          LLMEvent.textStart({
            id: state.currentTextID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      if (!dbg.firstDeltaLogged) {
        dbg.firstDeltaLogged = true
        console.log(`[LLM_DEBUG] +${elapsed}ms FIRST_TEXT_DELTA text="${event.text.slice(0, 80)}"`)
      }
      return Effect.succeed([
        LLMEvent.textDelta({
          id: currentTextID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        state.currentTextID = undefined
        return [
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-start":
      return Effect.sync(() => {
        state.currentReasoningID = currentReasoningID(state, event.id)
        return [
          LLMEvent.reasoningStart({
            id: state.currentReasoningID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: currentReasoningID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "reasoning-end":
      return Effect.sync(() => {
        const id = currentReasoningID(state, event.id)
        state.currentReasoningID = undefined
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        return [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input: event.input,
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: event.toolCallId,
            name,
            result: ToolResultValue.make(event.output),
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message: errorMessage(event.error),
            error: event.error,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "error":
      // DEBUG-2026-06-21: full error dump — was previously only Effect.fail'd
      // with no observable content. Stream-Text's onError hook also logs, but
      // this is the runtime path that actually reaches the processor.
      console.log(`[LLM_DEBUG] +${elapsed}ms ERROR error=${JSON.stringify(event.error)}`)
      return Effect.fail(event.error)

    case "abort":
    case "source":
    case "file":
    case "tool-output-denied":
    case "tool-approval-request":
      return Effect.succeed([])

    case "raw":
      return Effect.sync(() => {
        state.copilotTotalNanoAiu = copilotTotalNanoAiu(event.rawValue) ?? state.copilotTotalNanoAiu
        // DEBUG-2026-06-21: accumulate every raw chunk the provider sent.
        // The AI SDK fullStream exposes a "raw" event for every wire-level
        // chunk when the model was created with `includeRawChunks: true`
        // (already enabled in llm.ts). The final dump in case "finish"
        // gives us the complete wire payload for diagnosis.
        state.rawChunks.push(event.rawValue)
        return []
      })

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

export * as LLMAISDK from "./ai-sdk"
