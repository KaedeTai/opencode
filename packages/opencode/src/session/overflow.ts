import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const fallback =
    input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  const count = input.tokens.total || fallback
  // [OVERFLOW_DEBUG] log actual numbers so we can verify overflow detection
  // diagnostic: provider 'total' may exclude cache.read (cache is prefilled, not context cost)
  // fallback = input+output+cache.read+cache.write = full session size estimate
  console.log(
    `[OVERFLOW_DEBUG] providerTotal=${input.tokens.total} input=${input.tokens.input} output=${input.tokens.output} cache.read=${input.tokens.cache.read} cache.write=${input.tokens.cache.write} fallbackSum=${fallback} usable=${usable(input)} usingCount=${count} overflow=${count >= usable(input)} totalIncludesCache=${input.tokens.total >= input.tokens.input + input.tokens.cache.read}`,
  )
  return count >= usable(input)
}
